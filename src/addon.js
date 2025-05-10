const express = require('express');
const path = require('path');
const cors = require('cors');
const compression = require('compression');
const axios = require('axios');
const chronologicalData = require('../Data/chronologicalData');
const moviesData = require('../Data/moviesData');
const seriesData = require('../Data/seriesData');
const animationsData = require('../Data/animationsData');
const xmenData = require('../Data/xmenData');

require('dotenv').config();

// Configuração de chaves de API e porta
let tmdbKey, omdbKey, port;
try {
    ({ tmdbKey, omdbKey, port } = require('./config'));
} catch (error) {
    console.error('Error loading config.js. Using environment variables.', error);
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

// Cache de 3 semanas
app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'public, max-age=1814400');
    next();
});

// Health check para o Render
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Rota para servir configure.html
app.get('/configure', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

// Rota para catalog/id1,id2/configure
app.get('/catalog/:ids/configure', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

// Cache para catálogos
let cachedCatalog = {};

// Função auxiliar para buscar detalhes do TMDb
async function getTmdbDetails(id, type) {
    const url = `https://api.themoviedb.org/3/${type}/${id}?api_key=${tmdbKey}&language=en-US&append_to_response=external_ids`;
    try {
        const res = await axios.get(url);
        return res;
    } catch (err) {
        console.error(`TMDb details error for ${type}/${id}: ${err.message}`);
        return {};
    }
}

// Função para buscar dados adicionais (OMDb e TMDb)
async function fetchAdditionalData(item) {
    console.log('\n--- Fetching details for item: ---', item);

    // Validação básica do item
    if (!item || (!item.imdbId && !item.id) || !item.type || !item.title) {
        console.warn('Skipping item due to missing essential data:', item);
        return null;
    }
    const lookupId = item.imdbId || item.id;
    const idPrefix = lookupId.split('_')[0];
    const isImdb = idPrefix === 'tt' || (item.imdbId && !item.imdbId.startsWith('tmdb_'));

    // Verificar chaves de API
    if (!tmdbKey || (!omdbKey && isImdb)) {
        console.warn(`Skipping metadata fetch for ${item.title} (${lookupId}) because API keys are missing.`);
        return {
            id: lookupId,
            type: item.type,
            name: item.type === 'series' ? item.title.replace(/ Season \d+/, '') : item.title,
            poster: item.poster || null,
            description: item.overview || 'Metadata lookup unavailable (API key missing).',
            releaseInfo: item.releaseYear || 'N/A',
            imdbRating: 'N/A',
            genres: item.genres ? item.genres.map(g => g.name) : []
        };
    }

    let omdbData = {};
    let tmdbData = {};
    let tmdbImagesData = {};

    try {
        const omdbPromise = isImdb
            ? axios.get(`http://www.omdbapi.com/?i=${lookupId}&apikey=${omdbKey}`).catch((err) => {
                  console.error(`OMDB error for ${lookupId}: ${err.message}`);
                  return {};
              })
            : Promise.resolve({});

        let effectiveTmdbId = item.tmdbId || (idPrefix === 'tmdb' ? lookupId.split('_')[1] : null);
        let tmdbDetailsPromise;
        if (effectiveTmdbId) {
            const tmdbDetailsUrl = `https://api.themoviedb.org/3/${item.type}/${effectiveTmdbId}?api_key=${tmdbKey}&language=en-US`;
            tmdbDetailsPromise = axios.get(tmdbDetailsUrl).catch((err) => {
                console.error(`TMDB Details error for ${item.type}/${effectiveTmdbId}: ${err.message}`);
                return {};
            });
        } else {
            const tmdbSearchUrl = `https://api.themoviedb.org/3/search/${item.type}?api_key=${tmdbKey}&query=${encodeURIComponent(item.title)}&year=${item.releaseYear}`;
            tmdbDetailsPromise = axios.get(tmdbSearchUrl).then(res =>
                res.data?.results?.[0] ? getTmdbDetails(res.data.results[0].id, item.type) : {}
            ).catch((err) => {
                console.error(`TMDB Search error for ${item.title}: ${err.message}`);
                return {};
            });
        }

        const tmdbImagesPromise = tmdbDetailsPromise.then(detailsRes => {
            const foundTmdbId = detailsRes?.data?.id || effectiveTmdbId;
            if (foundTmdbId) {
                const tmdbImagesUrl = `https://api.themoviedb.org/3/${item.type}/${foundTmdbId}/images?api_key=${tmdbKey}`;
                return axios.get(tmdbImagesUrl).catch((err) => {
                    if (!err.response || err.response.status !== 404) {
                        console.warn(`TMDb Images error for ${item.title}: ${err.message}`);
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

        let poster = item.poster || null;
        if (!poster && tmdbData.poster_path) {
            poster = `https://image.tmdb.org/t/p/w500${tmdbData.poster_path}`;
        }
        if (!poster && omdbData.Poster && omdbData.Poster !== 'N/A') {
            poster = omdbData.Poster;
        }
        if (!poster) {
            poster = 'https://m.media-amazon.com/images/M/MV5BMTc5MDE2ODcwNV5BMl5BanBnXkFtZTgwMzI2NzQ2NzM@._V1_SX300.jpg';
            console.warn(`No poster found for ${item.title} (${lookupId}), using fallback.`);
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
        return null;
    }
}

// Função para ordenar dados por data de lançamento, tratando "TBA"
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

// Lista de todos os catálogos disponíveis
function getAllCatalogs() {
    return [
        {
            type: "Marvel",
            id: "marvel-mcu",
            name: "MCU Chronological Order"
        },
        {
            type: "Marvel",
            id: "xmen",
            name: "X-Men Collection"
        },
        {
            type: "Marvel",
            id: "movies",
            name: "Movies"
        },
        {
            type: "Marvel",
            id: "series",
            name: "Series"
        },
        {
            type: "Marvel",
            id: "animations",
            name: "Animations"
        }
    ];
}

// Manifest padrão
app.get('/manifest.json', (req, res) => {
    console.log('Default manifest requested');
    
    const manifest = {
        id: "com.tapframe.marveladdon",
        name: "Marvel Universe",
        description: "Explore the Marvel Universe with MCU, X-Men, movies, series, and animations!",
        version: "1.0.1",
        logo: "https://github.com/tapframe/addon-marvel/blob/main/assets/icon.png?raw=true",
        background: "https://github.com/tapframe/addon-marvel/blob/main/assets/background.jpg?raw=true",
        catalogs: getAllCatalogs(),
        resources: ["catalog"],
        types: ["movie", "series"],
        idPrefixes: ["marvel_"],
        behaviorHints: {
            configurable: true
        },
        contactEmail: "your-email@example.com"
    };
    
    res.json(manifest);
});

// Manifest personalizado
app.get('/catalog/:catalogsParam/manifest.json', (req, res) => {
    const catalogsParam = req.params.catalogsParam;
    const selectedCatalogIds = catalogsParam ? decodeURIComponent(catalogsParam).split(',') : [];
    console.log(`Custom catalog manifest requested - Selected catalogs: ${selectedCatalogIds.join(', ')}`);
    
    const allCatalogs = getAllCatalogs();
    let filteredCatalogs = allCatalogs;
    
    if (selectedCatalogIds.length > 0) {
        filteredCatalogs = allCatalogs.filter(catalog => selectedCatalogIds.includes(catalog.id));
    }
    
    const manifest = {
        id: "com.tapframe.marveladdon.custom",
        name: "Marvel Universe Custom",
        description: "Your personalized Marvel Universe collection",
        version: "1.0.1",
        logo: "https://github.com/tapframe/addon-marvel/blob/main/assets/icon.png?raw=true",
        background: "https://github.com/tapframe/addon-marvel/blob/main/assets/background.jpg?raw=true",
        catalogs: filteredCatalogs,
        resources: ["catalog"],
        types: ["movie", "series"],
        idPrefixes: ["marvel_"],
        behaviorHints: {
            configurable: true
        },
        contactEmail: "your-email@example.com"
    };
    
    res.json(manifest);
});

// Endpoint para informações de catálogos
app.get('/api/catalogs', (req, res) => {
    console.log('Catalog info requested');
    
    const catalogInfo = [
        { 
            id: 'marvel-mcu', 
            name: 'MCU Chronological Order', 
            category: 'Timeline',
            description: 'Browse the Marvel Cinematic Universe in chronological story order',
            icon: 'calendar-alt'
        },
        { 
            id: 'xmen', 
            name: 'X-Men Collection', 
            category: 'Character',
            description: 'All X-Men movies and related content',
            icon: 'mask'
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

// Endpoint de catálogo padrão
app.get('/catalog/:type/:id.json', async (req, res) => {
    const { type, id } = req.params;
    const genre = req.query.genre; // Suporte a ordenação por gênero (old/new)
    console.log(`Default catalog requested - Type: ${type}, ID: ${id}, Genre: ${genre || 'default'}`);
    
    const cacheKey = `default-${id}${genre ? `_${genre}` : ''}`;
    if (cachedCatalog[cacheKey]) {
        console.log(`✅ Returning cached catalog for ID: ${cacheKey}`);
        return res.json(cachedCatalog[cacheKey]);
    }
    
    let dataSource;
    let dataSourceName = id;
    
    try {
        switch (id) {
            case 'marvel-mcu':
                dataSource = chronologicalData;
                dataSourceName = 'MCU Chronological Order';
                break;
            case 'xmen':
                dataSource = xmenData;
                dataSourceName = 'X-Men Collection';
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
        
        // Aplicar ordenação se especificado
        if (genre === 'old') {
            dataSource = sortByReleaseDate([...dataSource], 'asc');
            console.log(`${dataSourceName} - Applying sort: asc (old to new)`);
        } else if (genre === 'new') {
            dataSource = sortByReleaseDate([...dataSource], 'desc');
            console.log(`${dataSourceName} - Applying sort: desc (new to old)`);
        } else {
            console.log(`${dataSourceName} - Using default order from data`);
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
    return res.json(cachedCatalog[cacheKey]);
});

// Endpoint de catálogo personalizado
app.get('/catalog/:catalogsParam/catalog/:type/:id.json', async (req, res) => {
    const { catalogsParam, type, id } = req.params;
    const genre = req.query.genre;
    console.log(`Custom catalog requested - Catalogs: ${catalogsParam}, Type: ${type}, ID: ${id}, Genre: ${genre || 'default'}`);
    
    const cacheKey = `custom-${id}-${catalogsParam}${genre ? `_${genre}` : ''}`;
    if (cachedCatalog[cacheKey]) {
        console.log(`✅ Returning cached catalog for ID: ${cacheKey}`);
        return res.json(cachedCatalog[cacheKey]);
    }
    
    let dataSource;
    let dataSourceName = id;
    
    try {
        switch (id) {
            case 'marvel-mcu':
                dataSource = chronologicalData;
                dataSourceName = 'MCU Chronological Order';
                break;
            case 'xmen':
                dataSource = xmenData;
                dataSourceName = 'X-Men Collection';
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
        } else {
            console.log(`${dataSourceName} - Using default order from data`);
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
    return res.json(cachedCatalog[cacheKey]);
});

// Rota padrão
app.get('/', (req, res) => {
    res.redirect('/configure');
});

// Iniciar servidor
app.listen(port, () => {
    console.log(`Marvel Universe Addon server running at http://localhost:${port}/`);
    console.log(`Configuration page: http://localhost:${port}/configure`);
    console.log(`To install with custom catalogs: http://localhost:${port}/catalog/CATALOG_IDS/manifest.json`);
});

// Exportar função para testes
module.exports = { fetchAdditionalData };
