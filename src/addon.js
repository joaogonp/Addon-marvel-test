const express = require('express');
const path = require('path');
const cors = require('cors');
const compression = require('compression');
const axios = require('axios');
const chronologicalData = require('../Data/chronologicalData');
const xmenData = require('../Data/xmenData');
const moviesData = require('../Data/moviesData');
const seriesData = require('../Data/seriesData');
const animationsData = require('../Data/animationsData');

require('dotenv').config();

// Get API keys and port
let tmdbKey, omdbKey, port;
try {
    ({ tmdbKey, omdbKey, port } = require('./config'));
} catch (error) {
    console.error('Error loading config.js. Falling back to environment variables.', error);
    port = process.env.PORT || 7000;
    tmdbKey = process.env.TMDB_API_KEY;
    omdbKey = process.env.OMDB_API_KEY;
    
    if (!tmdbKey || !omdbKey) {
        console.error('CRITICAL: API keys (TMDB_API_KEY, OMDB_API_KEY) are missing. Addon cannot fetch metadata.');
    }
}

const app = express();

// Middleware
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Cache for 3 weeks
app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'public, max-age=1814400');
    next();
});

// Health check for Render
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Serve configure.html for paths like /catalog/id1,id2/configure
app.get('/catalog/:ids/configure', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

// Configuration page
app.get('/configure', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

// Cache storage per ID
let cachedCatalog = {};

// Helper function to fetch TMDb details
async function getTmdbDetails(id, type) {
    const url = `https://api.themoviedb.org/3/${type}/${id}?api_key=${tmdbKey}&language=en-US&append_to_response=external_ids`;
    try {
        const res = await axios.get(url);
        return res;
    } catch (err) {
        console.error(`Error fetching TMDb details for ${type}/${id}: ${err.message}`);
        return {};
    }
}

// Helper function to replace posters with RPDB posters when a valid key is provided
function replaceRpdbPosters(rpdbKey, metas) {
    if (!rpdbKey) {
        return metas;
    }

    return metas.map(meta => {
        const imdbId = meta.id.startsWith('tt') ? meta.id : null;
        if (imdbId) {
            return {
                ...meta,
                poster: `https://api.ratingposterdb.com/${rpdbKey}/imdb/poster-default/${imdbId}.jpg`
            };
        }
        return meta;
    });
}

// Function to fetch additional metadata
async function fetchAdditionalData(item) {
    console.log('\n--- Fetching details for item: ---', item);

    // Basic item validation
    if (!item || (!item.imdbId && !item.id) || !item.type || !item.title) {
        console.warn('Skipping item due to missing essential data:', item);
        return null;
    }
    const lookupId = item.imdbId || item.id;
    const idPrefix = lookupId.split('_')[0];
    const isImdb = idPrefix === 'tt' || (item.imdbId && !item.imdbId.startsWith('tmdb_'));

    // Check if API keys are available
    if (!tmdbKey || (!omdbKey && isImdb)) {
        console.warn(`Skipping metadata fetch for ${item.title} (${lookupId}) due to missing API keys.`);
        return {
            id: lookupId,
            type: item.type,
            name: item.type === 'series' ? item.title.replace(/ Season \d+/, '') : item.title,
            poster: item.poster || 'https://m.media-amazon.com/images/M/MV5BMTc5MDE2ODcwNV5BMl5BanBnXkFtZTgwMzI2NzQ2NzM@._V1_SX300.jpg',
            description: item.overview || 'Metadata fetch unavailable (missing API key).',
            releaseInfo: item.releaseYear || 'N/A',
            imdbRating: 'N/A',
            genres: item.genres ? item.genres.map(g => g.name) : ['Action', 'Adventure']
        };
    }

    let omdbData = {};
    let tmdbData = {};
    let tmdbImagesData = {};

    try {
        // OMDb call only if we have a real IMDb ID
        const omdbPromise = isImdb
            ? axios.get(`http://www.omdbapi.com/?i=${lookupId}&apikey=${omdbKey}`).catch((err) => {
                  console.error(`OMDb error for ${lookupId}: ${err.message}`);
                  return {};
              })
            : Promise.resolve({});

        // TMDb search/details call
        let effectiveTmdbId = item.tmdbId || (idPrefix === 'tmdb' ? lookupId.split('_')[1] : null);
        let tmdbDetailsPromise;
        if (effectiveTmdbId) {
            const tmdbDetailsUrl = `https://api.themoviedb.org/3/${item.type}/${effectiveTmdbId}?api_key=${tmdbKey}&language=en-US`;
            tmdbDetailsPromise = axios.get(tmdbDetailsUrl).catch((err) => {
                console.error(`TMDb details error for ${item.type}/${effectiveTmdbId}: ${err.message}`);
                return {};
            });
        } else {
            const tmdbSearchUrl = `https://api.themoviedb.org/3/search/${item.type}?api_key=${tmdbKey}&query=${encodeURIComponent(item.title)}&year=${item.releaseYear}`;
            tmdbDetailsPromise = axios.get(tmdbSearchUrl).then(res =>
                res.data?.results?.[0] ? getTmdbDetails(res.data.results[0].id, item.type) : {}
            ).catch((err) => {
                console.error(`TMDb search error for ${item.title}: ${err.message}`);
                return {};
            });
        }

        // Fetch images using TMDb ID
        const tmdbImagesPromise = tmdbDetailsPromise.then(detailsRes => {
            const foundTmdbId = detailsRes?.data?.id || effectiveTmdbId;
            if (foundTmdbId) {
                const tmdbImagesUrl = `https://api.themoviedb.org/3/${item.type}/${foundTmdbId}/images?api_key=${tmdbKey}`;
                return axios.get(tmdbImagesUrl).catch((err) => {
                    if (!err.response || err.response.status !== 404) {
                        console.warn(`TMDb images error for ${item.title}: ${err.message}`);
                    }
                    return {};
                });
            } else {
                return Promise.resolve({});
            }
        });

        console.log(`Fetching data for ${item.title} (${lookupId})...`);
        const [omdbRes, tmdbDetailsResult, tmdbImagesRes] = await Promise.all([
            omdbPromise,
            tmdbDetailsPromise,
            tmdbImagesPromise
        ]);

        omdbData = omdbRes.data || {};
        tmdbData = tmdbDetailsResult.data || {};
        tmdbImagesData = tmdbImagesRes.data || {};

        // Poster priority: local -> TMDb -> OMDb -> fallback
        let poster = item.poster || null;
        if (!poster && tmdbData.poster_path) {
            poster = `https://image.tmdb.org/t/p/w500${tmdbData.poster_path}`;
        }
        if (!poster && omdbData.Poster && omdbData.Poster !== 'N/A') {
            poster = omdbData.Poster;
        }
        if (!poster) {
            poster = 'https://m.media-amazon.com/images/M/MV5BMTc5MDE2ODcwNV5BMl5BanBnXkFtZTgwMzI2NzQ2NzM@._V1_SX300.jpg';
            console.warn(`No valid poster found for ${item.title} (${lookupId}), using fallback.`);
        }

        let logoUrl = null;
        if (tmdbImagesData.logos && tmdbImagesData.logos.length > 0) {
            let bestLogo = tmdbImagesData.logos.find(logo => logo.iso_639_1 === 'en') || tmdbImagesData.logos[0];
            if (bestLogo && bestLogo.file_path) {
                logoUrl = `https://image.tmdb.org/t/p/original${bestLogo.file_path}`;
            }
        }

        const description = item.overview || tmdbData.overview || omdbData.Plot || 'No description available.';

        const meta = {
            id: lookupId,
            type: item.type,
            name: item.type === 'series' ? item.title.replace(/ Season \d+/, '') : item.title,
            logo: logoUrl,
            poster: poster,
            description: description,
            releaseInfo: item.releaseYear || (tmdbData.release_date ? tmdbData.release_date.split('-')[0] : (tmdbData.first_air_date ? tmdbData.first_air_date.split('-')[0] : 'N/A')),
            imdbRating: omdbData.imdbRating || 'N/A',
            genres: tmdbData.genres ? tmdbData.genres.map(g => g.name) : (item.genres ? item.genres.map(g => g.name) : ['Action', 'Adventure'])
        };

        console.log('   > Returning metadata:', { ...meta, description: meta.description.substring(0, 50) + '...' });
        return meta;
    } catch (err) {
        console.error(`Error processing ${item.title} (${lookupId}): ${err.message}`);
        return {
            id: lookupId,
            type: item.type,
            name: item.type === 'series' ? item.title.replace(/ Season \d+/, '') : item.title,
            poster: item.poster || 'https://m.media-amazon.com/images/M/MV5BMTc5MDE2ODcwNV5BMl5BanBnXkFtZTgwMzI2NzQ2NzM@._V1_SX300.jpg',
            description: item.overview || 'No description available.',
            releaseInfo: item.releaseYear || 'N/A',
            imdbRating: 'N/A',
            genres: item.genres ? item.genres.map(g => g.name) : ['Action', 'Adventure']
        };
    }
}

// Function to sort data by release date
function sortByReleaseDate(data, order = 'desc') {
    return [...data].sort((a, b) => {
        const dateA = a.releaseInfo || a.releaseYear;
        const dateB = b.releaseInfo || b.releaseYear;
        const isTBA_A = dateA === 'TBA' || dateA === null || isNaN(new Date(dateA).getTime());
        const isTBA_B = dateB === 'TBA' || dateB === null || isNaN(new Date(dateB).getTime());

        if (isTBA_A && isTBA_B) return 0;
        if (isTBA_A) return order === 'asc' ? 1 : -1;
        if (isTBA_B) return order === 'asc' ? -1 : 1;

        const timeA = new Date(dateA).getTime();
        const timeB = new Date(dateB).getTime();
        return order === 'asc' ? timeA - timeB : timeB - timeA;
    });
}

// List of all available catalogs
function getAllCatalogs() {
    return [
        {
            type: "Marvel",
            id: "marvel-mcu",
            name: "MCU Chronologically Ordered",
            extra: [
                {
                    name: "genre",
                    options: ["new", "old"],
                    isRequired: false,
                    default: null,
                    optionLabels: {
                        new: "New to Old",
                        old: "Old to New"
                    }
                }
            ],
            behaviorHints: {
                orderHint: 1
            }
        },
        {
            type: "Marvel",
            id: "xmen",
            name: "X-Men",
            behaviorHints: {
                orderHint: 2
            }
        },
        {
            type: "Marvel",
            id: "movies",
            name: "Movies",
            extra: [
                {
                    name: "genre",
                    options: ["new"],
                    isRequired: false,
                    default: null,
                    optionLabels: {
                        new: "New to Old"
                    }
                }
            ],
            behaviorHints: {
                orderHint: 3
            }
        },
        {
            type: "Marvel",
            id: "series",
            name: "Series",
            extra: [
                {
                    name: "genre",
                    options: ["new"],
                    isRequired: false,
                    default: null,
                    optionLabels: {
                        new: "New to Old"
                    }
                }
            ],
            behaviorHints: {
                orderHint: 4
            }
        },
        {
            type: "Marvel",
            id: "animations",
            name: "Animations",
            extra: [
                {
                    name: "genre",
                    options: ["new", "old"],
                    isRequired: false,
                    default: "old",
                    optionLabels: {
                        new: "New to Old",
                        old: "Old to New"
                    }
                }
            ],
            behaviorHints: {
                orderHint: 5
            }
        }
    ];
}

// Default manifest
app.get('/manifest.json', (req, res) => {
    console.log('Default manifest requested');
    
    const rpdbKey = req.query.rpdb || null;
    if (rpdbKey) {
        console.log(`Default manifest with RPDB key: ${rpdbKey.substring(0, 4)}...`);
    }
    
    const manifestId = rpdbKey 
        ? "com.joaogonp.marveladdon.rpdb"
        : "com.joaogonp.marveladdon";
    
    const manifest = {
        id: manifestId,
        name: "Marvel Teste",
        description: "Watch the complete Marvel catalog! MCU and X-Men (chronologically ordered), Movies, Series, and Animations!",
        version: "1.3.0",
        logo: "https://raw.githubusercontent.com/joaogonp/addon-marvel/main/assets/icon.png",
        background: "https://raw.githubusercontent.com/joaogonp/addon-marvel/main/assets/background.jpg",
        catalogs: getAllCatalogs(),
        resources: ["catalog"],
        types: ["movie", "series"],
        idPrefixes: ["marvel_"],
        behaviorHints: {
            configurable: true
        },
        contactEmail: "jpnapsp@gmail.com",
        stremioAddonsConfig: {
            issuer: "https://stremio-addons.net",
            signature: "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..zTaTTCcviqQPiIvU4QDfCQ.wSlk8AoM4p2nvlvoQJEoLRRx5_Msnu37O9bAsgwhJTZYu4uXd7Cve9GaVXdnwZ4nAeNSsRSgp51mofhf0EVQYwx7jGxh4FEvs8MMuWeHQ9alNsqVuy3-Mc459B9myIT-.R_1iaQbNExj4loQJlyWYtA"
        }
    };
    
    res.json(manifest);
});

// RPDB-based manifest
app.get('/rpdb/:rpdbKey/manifest.json', (req, res) => {
    const { rpdbKey } = req.params;
    console.log(`RPDB-based manifest requested with key: ${rpdbKey.substring(0, 4)}...`);
    
    const manifestId = `com.joaogonp.marveladdon.rpdb.${rpdbKey.substring(0, 8)}`;
    
    const manifest = {
        id: manifestId,
        name: "Marvel Teste",
        description: "Watch the complete Marvel catalog with IMDb ratings on posters! MCU and X-Men (chronologically ordered), Movies, Series, and Animations!",
        version: "1.3.0",
        logo: "https://raw.githubusercontent.com/joaogonp/addon-marvel/main/assets/icon.png",
        background: "https://raw.githubusercontent.com/joaogonp/addon-marvel/main/assets/background.jpg",
        catalogs: getAllCatalogs(),
        resources: ["catalog"],
        types: ["movie", "series"],
        idPrefixes: ["marvel_"],
        behaviorHints: {
            configurable: true
        },
        contactEmail: "jpnapsp@gmail.com",
        stremioAddonsConfig: {
            issuer: "https://stremio-addons.net",
            signature: "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..zTaTTCcviqQPiIvU4QDfCQ.wSlk8AoM4p2nvlvoQJEoLRRx5_Msnu37O9bAsgwhJTZYu4uXd7Cve9GaVXdnwZ4nAeNSsRSgp51mofhf0EVQYwx7jGxh4FEvs8MMuWeHQ9alNsqVuy3-Mc459B9myIT-.R_1iaQbNExj4loQJlyWYtA"
        }
    };
    
    res.json(manifest);
});

// Custom catalog manifest
app.get('/catalog/:catalogsParam/manifest.json', (req, res) => {
    const { catalogsParam } = req.params;
    
    let rpdbKey = null;
    let selectedCatalogIds = catalogsParam;
    
    if (catalogsParam.includes(':')) {
        const parts = catalogsParam.split(':');
        selectedCatalogIds = parts[0];
        rpdbKey = parts[1];
        console.log(`Custom manifest with RPDB key: ${rpdbKey.substring(0, 4)}...`);
        selectedCatalogIds = selectedCatalogIds.split(',').map(id => id.trim());
    } else {
        selectedCatalogIds = catalogsParam.split(',').map(id => id.trim());
    }

    const allCatalogs = getAllCatalogs();
    const selectedApiCatalogs = allCatalogs.filter(catalog => selectedCatalogIds.includes(catalog.id));
    
    if (selectedApiCatalogs.length === 0) {
        return res.status(404).send('No valid catalogs selected or found.');
    }
    
    const customId = rpdbKey 
        ? `com.joaogonp.marveladdon.custom.${selectedCatalogIds.join('.')}.rpdb`
        : `com.joaogonp.marveladdon.custom.${selectedCatalogIds.join('.')}`;
    
    const manifestId = customId.slice(0, 100);
    
    const manifest = {
        id: manifestId,
        name: "Marvel Teste Custom",
        description: `Your custom Marvel catalog: ${selectedApiCatalogs.map(c => c.name).join(', ')}`,
        version: "1.3.0",
        logo: "https://raw.githubusercontent.com/joaogonp/addon-marvel/main/assets/icon.png",
        background: "https://raw.githubusercontent.com/joaogonp/addon-marvel/main/assets/background.jpg",
        catalogs: selectedApiCatalogs,
        resources: ["catalog"],
        types: ["movie", "series"],
        idPrefixes: ["marvel_"],
        behaviorHints: {
            configurable: true
        },
        contactEmail: "jpnapsp@gmail.com",
        stremioAddonsConfig: {
            issuer: "https://stremio-addons.net",
            signature: "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..zTaTTCcviqQPiIvU4QDfCQ.wSlk8AoM4p2nvlvoQJEoLRRx5_Msnu37O9bAsgwhJTZYu4uXd7Cve9GaVXdnwZ4nAeNSsRSgp51mofhf0EVQYwx7jGxh4FEvs8MMuWeHQ9alNsqVuy3-Mc459B9myIT-.R_1iaQbNExj4loQJlyWYtA"
        }
    };
    
    res.json(manifest);
});

// Catalog information endpoint
app.get('/api/catalogs', (req, res) => {
    console.log('Catalog information requested');
    
    const catalogInfo = [
        { 
            id: 'marvel-mcu', 
            name: 'MCU Chronologically Ordered', 
            category: 'Timeline',
            description: 'Browse the Marvel Cinematic Universe in chronological story order',
            icon: 'mcu-logo'
        },
        { 
            id: 'xmen', 
            name: 'X-Men', 
            category: 'Character',
            description: 'All movies and content related to the X-Men',
            icon: 'xmen-logo'
        },
        { 
            id: 'movies', 
            name: 'Movies', 
            category: 'Content Type',
            description: 'All Marvel movies across different franchises',
            icon: 'film'
        },
        { 
            id: 'series', 
            name: 'Series', 
            category: 'Content Type',
            description: 'All Marvel television series',
            icon: 'tv'
        },
        { 
            id: 'animations', 
            name: 'Animations', 
            category: 'Content Type',
            description: 'All Marvel animated features and series',
            icon: 'play-circle'
        }
    ];
    
    res.json(catalogInfo);
});

// RPDB-based catalog endpoint
app.get('/rpdb/:rpdbKey/catalog/:type/:id.json', async (req, res) => {
    const { rpdbKey, type, id } = req.params;
    const genre = req.query.genre;
    console.log(`RPDB-based catalog requested - Type: ${type}, ID: ${id}, RPDB Key: ${rpdbKey.substring(0, 4)}..., Genre: ${genre || 'default'}`);
    
    const cacheKey = `default-${id}${genre ? `_${genre}` : ''}`;
    if (cachedCatalog[cacheKey]) {
        console.log(`✅ Returning cached catalog for ID: ${cacheKey} with RPDB posters`);
        const metasWithRpdbPosters = replaceRpdbPosters(rpdbKey, cachedCatalog[cacheKey].metas);
        return res.json({ metas: metasWithRpdbPosters });
    }
    
    let dataSource;
    let dataSourceName = id;
    
    try {
        switch (id) {
            case 'marvel-mcu':
                dataSource = chronologicalData;
                dataSourceName = 'MCU Chronologically Ordered';
                break;
            case 'xmen':
                dataSource = xmenData;
                dataSourceName = 'X-Men';
                break;
            case 'movies':
                dataSource = moviesData;
                dataSourceName = 'Movies';
                break;
            case 'series':
                dataSource = seriesData;
                dataSourceName = 'Series';
                break;
            case 'animations':
                dataSource = animationsData;
                dataSourceName = 'Animations';
                break;
            default:
                console.warn(`Unrecognized catalog ID: ${id}`);
                return res.json({ metas: [] });
        }
        
        if (!Array.isArray(dataSource)) {
            throw new Error(`Data source for ID ${id} is not a valid array.`);
        }
        console.log(`Loaded ${dataSource.length} items for catalog: ${dataSourceName}`);
        
        if (genre === 'old') {
            dataSource = sortByReleaseDate([...dataSource], 'asc');
            console.log(`${dataSourceName} - Applying sort: asc (old to new)`);
        } else if (genre === 'new') {
            dataSource = sortByReleaseDate([...dataSource], 'desc');
            console.log(`${dataSourceName} - Applying sort: desc (new to old)`);
        } else if (id === 'animations' && !genre) {
            dataSource = sortByReleaseDate([...dataSource], 'asc');
            console.log(`${dataSourceName} - Applying default sort: asc (old to new)`);
        } else {
            console.log(`${dataSourceName} - Using default data order`);
        }
    } catch (error) {
        console.error(`❌ Error loading data for catalog ID ${id}:`, error.message);
        return res.json({ metas: [] });
    }
    
    console.log(`⏳ Generating catalog for ${dataSourceName} with RPDB posters...`);
    const metas = await Promise.all(
        dataSource.map(item => fetchAdditionalData(item))
    );
    
    const validMetas = metas.filter(item => item !== null);
    console.log(`✅ Catalog generated with ${validMetas.length} items for ID: ${id}`);
    
    cachedCatalog[cacheKey] = { metas: validMetas };
    
    const metasWithRpdbPosters = replaceRpdbPosters(rpdbKey, validMetas);
    return res.json({ metas: metasWithRpdbPosters });
});

// Custom catalog endpoint
app.get('/catalog/:catalogsParam/catalog/:type/:id.json', async (req, res) => {
    const { catalogsParam, type, id } = req.params;
    const genre = req.query.genre;
    console.log(`Custom catalog requested - Catalogs: ${catalogsParam}, Type: ${type}, ID: ${id}, Genre: ${genre || 'default'}`);
    
    let rpdbKey = null;
    let catalogIds = catalogsParam;
    
    if (catalogsParam.includes(':')) {
        const parts = catalogsParam.split(':');
        catalogIds = parts[0];
        rpdbKey = parts[1];
        console.log(`RPDB key detected: ${rpdbKey.substring(0, 4)}...`);
    }
    
    const cacheKey = `custom-${id}-${catalogsParam}${genre ? `_${genre}` : ''}`;
    if (cachedCatalog[cacheKey]) {
        console.log(`✅ Returning cached catalog for ID: ${cacheKey}`);
        if (rpdbKey) {
            const metasWithRpdbPosters = replaceRpdbPosters(rpdbKey, cachedCatalog[cacheKey].metas);
            return res.json({ metas: metasWithRpdbPosters });
        }
        return res.json(cachedCatalog[cacheKey]);
    }
    
    let dataSource;
    let dataSourceName = id;
    
    try {
        switch (id) {
            case 'marvel-mcu':
                dataSource = chronologicalData;
                dataSourceName = 'MCU Chronologically Ordered';
                break;
            case 'xmen':
                dataSource = xmenData;
                dataSourceName = 'X-Men';
                break;
            case 'movies':
                dataSource = moviesData;
                dataSourceName = 'Movies';
                break;
            case 'series':
                dataSource = seriesData;
                dataSourceName = 'Series';
                break;
            case 'animations':
                dataSource = animationsData;
                dataSourceName = 'Animations';
                break;
            default:
                console.warn(`Unrecognized catalog ID: ${id}`);
                return res.json({ metas: [] });
        }
        
        if (!Array.isArray(dataSource)) {
            throw new Error(`Data source for ID ${id} is not a valid array.`);
        }
        console.log(`Loaded ${dataSource.length} items for catalog: ${dataSourceName}`);
        
        if (genre === 'old') {
            dataSource = sortByReleaseDate([...dataSource], 'asc');
            console.log(`${dataSourceName} - Applying sort: asc (old to new)`);
        } else if (genre === 'new') {
            dataSource = sortByReleaseDate([...dataSource], 'desc');
            console.log(`${dataSourceName} - Applying sort: desc (new to old)`);
        } else if (id === 'animations' && !genre) {
            dataSource = sortByReleaseDate([...dataSource], 'asc');
            console.log(`${dataSourceName} - Applying default sort: asc (old to new)`);
        } else {
            console.log(`${dataSourceName} - Using default data order`);
        }
    } catch (error) {
        console.error(`❌ Error loading data for catalog ID ${id}:`, error.message);
        return res.json({ metas: [] });
    }
    
    console.log(`⏳ Generating catalog for ${dataSourceName}...`);
    const metas = await Promise.all(
        dataSource.map(item => fetchAdditionalData(item))
    );
    
    const validMetas = metas.filter(item => item !== null);
    console.log(`✅ Catalog generated with ${validMetas.length} items for ID: ${id}`);
    
    cachedCatalog[cacheKey] = { metas: validMetas };
    
    if (rpdbKey) {
        const metasWithRpdbPosters = replaceRpdbPosters(rpdbKey, validMetas);
        return res.json({ metas: metasWithRpdbPosters });
    }
    
    return res.json(cachedCatalog[cacheKey]);
});

// Default catalog endpoint
app.get('/catalog/:type/:id.json', async (req, res) => {
    const { type, id } = req.params;
    const genre = req.query.genre;
    console.log(`Default catalog requested - Type: ${type}, ID: ${id}, Genre: ${genre || 'default'}`);
    
    let rpdbKey = req.query.rpdb || null;
    const referer = req.get('Referrer') || '';
    if (!rpdbKey && referer) {
        const rpdbMatch = referer.match(/\/rpdb\/([^\/]+)\/manifest\.json/);
        if (rpdbMatch && rpdbMatch[1]) {
            rpdbKey = decodeURIComponent(rpdbMatch[1]);
        }
    }
    
    if (rpdbKey) {
        console.log(`RPDB key detected: ${rpdbKey.substring(0, 4)}...`);
    }
    
    const cacheKey = `default-${id}${genre ? `_${genre}` : ''}`;
    if (cachedCatalog[cacheKey]) {
        console.log(`✅ Returning cached catalog for ID: ${cacheKey}`);
        if (rpdbKey) {
            const metasWithRpdbPosters = replaceRpdbPosters(rpdbKey, cachedCatalog[cacheKey].metas);
            return res.json({ metas: metasWithRpdbPosters });
        }
        return res.json(cachedCatalog[cacheKey]);
    }
    
    let dataSource;
    let dataSourceName = id;
    
    try {
        switch (id) {
            case 'marvel-mcu':
                dataSource = chronologicalData;
                dataSourceName = 'MCU Chronologically Ordered';
                break;
            case 'xmen':
                dataSource = xmenData;
                dataSourceName = 'X-Men';
                break;
            case 'movies':
                dataSource = moviesData;
                dataSourceName = 'Movies';
                break;
            case 'series':
                dataSource = seriesData;
                dataSourceName = 'Series';
                break;
            case 'animations':
                dataSource = animationsData;
                dataSourceName = 'Animations';
                break;
            default:
                console.warn(`Unrecognized catalog ID: ${id}`);
                return res.json({ metas: [] });
        }
        
        if (!Array.isArray(dataSource)) {
            throw new Error(`Data source for ID ${id} is not a valid array.`);
        }
        console.log(`Loaded ${dataSource.length} items for catalog: ${dataSourceName}`);
        
        if (genre === 'old') {
            dataSource = sortByReleaseDate([...dataSource], 'asc');
            console.log(`${dataSourceName} - Applying sort: asc (old to new)`);
        } else if (genre === 'new') {
            dataSource = sortByReleaseDate([...dataSource], 'desc');
            console.log(`${dataSourceName} - Applying sort: desc (new to old)`);
        } else if (id === 'animations' && !genre) {
            dataSource = sortByReleaseDate([...dataSource], 'asc');
            console.log(`${dataSourceName} - Applying default sort: asc (old to new)`);
        } else {
            console.log(`${dataSourceName} - Using default data order`);
        }
    } catch (error) {
        console.error(`❌ Error loading data for catalog ID ${id}:`, error.message);
        return res.json({ metas: [] });
    }
    
    console.log(`⏳ Generating catalog for ${dataSourceName}...`);
    const metas = await Promise.all(
        dataSource.map(item => fetchAdditionalData(item))
    );
    
    const validMetas = metas.filter(item => item !== null);
    console.log(`✅ Catalog generated with ${validMetas.length} items for ID: ${id}`);
    
    cachedCatalog[cacheKey] = { metas: validMetas };
    
    if (rpdbKey) {
        const metasWithRpdbPosters = replaceRpdbPosters(rpdbKey, validMetas);
        return res.json({ metas: metasWithRpdbPosters });
    }
    
    return res.json(cachedCatalog[cacheKey]);
});

// Default routes
app.get('/', (req, res) => {
    res.redirect('/configure');
});

app.listen(port, () => {
    console.log(`Marvel Teste Addon server running at http://localhost:${port}/`);
    console.log(`Configuration page: http://localhost:${port}/configure`);
    console.log(`To install with custom catalogs: http://localhost:${port}/catalog/CATALOG_IDS/manifest.json`);
});

// Export fetchAdditionalData for testing
module.exports = { fetchAdditionalData };
