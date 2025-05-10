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

// Estado para rastrear chaves RPDB inválidas
const invalidRpdbKeys = new Set();

// Limpar cache de chaves inválidas ao iniciar
invalidRpdbKeys.clear();
console.log('Invalid RPDB keys cache cleared on startup.');

// Endpoint para limpar cache
app.get('/api/clear-cache', (req, res) => {
    cachedCatalog = {};
    invalidRpdbKeys.clear();
    console.log('Cache and invalid RPDB keys cleared.');
    res.json({ message: 'Cache cleared successfully.' });
});

// Função auxiliar para extrair RPDB_API_KEY de catalogsParam
function extractRpdbKey(catalogsParam) {
    if (!catalogsParam) return null;
    const params = decodeURIComponent(catalogsParam).split(',');
    const rpdbParam = params.find(param => param.startsWith('rpdb_'));
    return rpdbParam ? rpdbParam.replace('rpdb_', '') : null;
}

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

// Função para validar RPDB_API_KEY
async function validateRpdbKey(rpdbKey) {
    if (!rpdbKey || invalidRpdbKeys.has(rpdbKey)) {
        console.log(`RPDB key ${rpdbKey?.substring(0, 4)}... skipped (empty or cached as invalid)`);
        return false;
    }

    // Sanitizar chave
    const sanitizedKey = rpdbKey.trim();
    const testUrl = `https://api.ratingposterdb.com/ratings/movie/tt0848228?api_key=${encodeURIComponent(sanitizedKey)}`;
    console.log(`Attempting RPDB validation with URL: ${testUrl.substring(0, 100)}...`);

    try {
        const res = await axios.get(testUrl, {
            validateStatus: status => status < 500,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; Marvel-Addon/1.2.0; https://seu-app.onrender.com)'
            }
        });
        console.log(`RPDB validation response for key ${sanitizedKey.substring(0, 4)}...: Status ${res.status}, Data:`, res.data);
        if (res.status === 200) {
            console.log(`RPDB key validation successful for key: ${sanitizedKey.substring(0, 4)}...`);
            return true;
        }
        console.warn(`RPDB key validation failed for key: ${sanitizedKey.substring(0, 4)}... (Status: ${res.status}, Data: ${JSON.stringify(res.data)})`);
        if (res.status === 403) {
            invalidRpdbKeys.add(sanitizedKey);
            console.warn(`RPDB API Key ${sanitizedKey.substring(0, 4)}... marked as invalid.`);
        }
        return false;
    } catch (err) {
        console.error(`RPDB validation error for key ${sanitizedKey.substring(0, 4)}...`, err.message);
        if (err.response) {
            console.log(`RPDB error response: Status ${err.response.status}, Data:`, err.response.data);
            if (err.response.status === 403) {
                invalidRpdbKeys.add(sanitizedKey);
                console.warn(`RPDB API Key ${sanitizedKey.substring(0, 4)}... marked as invalid due to 403.`);
            }
        }
        return false;
    }
}

// Endpoint para validar RPDB_API_KEY
app.get('/api/validate-rpdb', async (req, res) => {
    const rpdbKey = req.query.key;
    if (!rpdbKey) {
        return res.status(400).json({ valid: false, error: 'No RPDB API Key provided.' });
    }

    const isValid = await validateRpdbKey(rpdbKey);
    if (isValid) {
        return res.json({ valid: true });
    }
    return res.status(400).json({
        valid: false,
        error: 'Invalid RPDB API Key. Copy the key exactly from ratingposterdb.com without spaces, check its status in your RPDB dashboard, or contact RPDB support at https://ratingposterdb.com/support.'
    });
});

// Função para buscar ratings e posters do RPDB
async function getRpdbRatings(imdbId, tmdbId, type, rpdbKey) {
    if (!rpdbKey || invalidRpdbKeys.has(rpdbKey)) {
        console.log(`Skipping RPDB ratings for ${imdbId || tmdbId} (no valid key)`);
        return {};
    }

    const isValidKey = await validateRpdbKey(rpdbKey);
    if (!isValidKey) {
        console.log(`RPDB key ${rpdbKey.substring(0, 4)}... invalid, skipping ratings/posters`);
        return {};
    }

    const id = imdbId && imdbId.startsWith('tt') ? imdbId : tmdbId ? `tmdb:${tmdbId}` : null;
    if (!id) {
        console.warn('No valid IMDb ID or TMDb ID for RPDB query.');
        return {};
    }

    // Buscar ratings
    const ratingsUrl = `https://api.ratingposterdb.com/ratings/${type}/${id}?api_key=${encodeURIComponent(rpdbKey)}`;
    let ratingsData = {};
    try {
        const ratingsRes = await axios.get(ratingsUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; Marvel-Addon/1.2.0; https://seu-app.onrender.com)'
            }
        });
        ratingsData = ratingsRes.data || {};
        console.log(`RPDB ratings fetched for ${id}:`, ratingsData);
    } catch (err) {
        if (err.response?.status !== 403) {
            console.error(`RPDB ratings error for ${id}: ${err.message}, Status: ${err.response?.status}, Data: ${JSON.stringify(err.response?.data)}`);
        }
    }

    // Buscar poster (apenas para Tier 1)
    let posterData = {};
    const posterUrl = `https://api.ratingposterdb.com/posters/${type}/${id}?api_key=${encodeURIComponent(rpdbKey)}`;
    try {
        const posterRes = await axios.get(posterUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; Marvel-Addon/1.2.0; https://seu-app.onrender.com)'
            }
        });
        posterData = posterRes.data || {};
        console.log(`RPDB poster fetched for ${id}:`, posterData.poster || 'No poster');
    } catch (err) {
        if (err.response?.status === 403) {
            console.warn(`RPDB poster access denied for ${id} (likely not Tier 1).`);
        } else if (err.response?.status !== 404) {
            console.error(`RPDB poster error for ${id}: ${err.message}, Status: ${err.response?.status}, Data: ${JSON.stringify(err.response?.data)}`);
        }
    }

    return {
        ...ratingsData,
        poster: posterData.poster || null
    };
}

// Função para buscar dados adicionais (TMDb, OMDb, RPDB)
async function fetchAdditionalData(item, rpdbKey) {
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
            rottenTomatoesRating: 'N/A',
            genres: item.genres ? item.genres.map(g => g.name) : []
        };
    }

    let omdbData = {};
    let tmdbData = {};
    let tmdbImagesData = {};
    let rpdbData = {};

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
            // Tentar busca sem ano primeiro, depois com ano
            let tmdbSearchUrl = `https://api.themoviedb.org/3/search/${item.type}?api_key=${tmdbKey}&query=${encodeURIComponent(item.title)}`;
            tmdbDetailsPromise = axios.get(tmdbSearchUrl).then(res => {
                if (res.data?.results?.[0]) {
                    return getTmdbDetails(res.data.results[0].id, item.type);
                }
                // Fallback com ano
                tmdbSearchUrl += `&year=${item.releaseYear}`;
                return axios.get(tmdbSearchUrl).then(res =>
                    res.data?.results?.[0] ? getTmdbDetails(res.data.results[0].id, item.type) : {}
                );
            }).catch((err) => {
                console.warn(`TMDB Search error for ${item.title}: ${err.message}`);
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

        const rpdbPromise = rpdbKey
            ? getRpdbRatings(lookupId, effectiveTmdbId, item.type, rpdbKey)
            : Promise.resolve({});

        console.log(`Fetching data for ${item.title} (${lookupId})...`);
        const [omdbRes, tmdbDetailsResult, tmdbImagesRes, rpdbRes] = await Promise.all([
            omdbPromise,
            tmdbDetailsPromise,
            tmdbImagesPromise,
            rpdbPromise
        ]);

        omdbData = omdbRes.data || {};
        tmdbData = tmdbDetailsResult.data || {};
        tmdbImagesData = tmdbImagesRes.data || {};
        rpdbData = rpdbRes || {};

        // Verificar se a URL do poster é válida
        async function isValidImageUrl(url) {
            if (!url) return false;
            try {
                const res = await axios.head(url, { timeout: 5000 });
                return res.status === 200 && res.headers['content-type'].startsWith('image/');
            } catch {
                return false;
            }
        }

        // Priorizar poster: RPDB (se chave válida e Tier 1) > item.poster > TMDb > OMDb > fallback
        let poster = null;
        if (rpdbKey && rpdbData.poster && (await isValidImageUrl(rpdbData.poster))) {
            poster = rpdbData.poster;
            console.log(`Using RPDB poster for ${item.title}: ${poster}`);
        } else if (item.poster && (await isValidImageUrl(item.poster))) {
            poster = item.poster;
            console.log(`Using data file poster for ${item.title}: ${poster}`);
        } else if (tmdbData.poster_path && (await isValidImageUrl(`https://image.tmdb.org/t/p/w500${tmdbData.poster_path}`))) {
            poster = `https://image.tmdb.org/t/p/w500${tmdbData.poster_path}`;
            console.log(`Using TMDb poster for ${item.title}: ${poster}`);
        } else if (omdbData.Poster && omdbData.Poster !== 'N/A' && (await isValidImageUrl(omdbData.Poster))) {
            poster = omdbData.Poster;
            console.log(`Using OMDb poster for ${item.title}: ${poster}`);
        } else {
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

        // Validar tipo do item retornado pelo TMDb
        const expectedType = item.type;
        if (tmdbData.id && tmdbData.media_type && tmdbData.media_type !== expectedType) {
            console.warn(`TMDb returned wrong media type for ${item.title} (${lookupId}): expected ${expectedType}, got ${tmdbData.media_type}`);
        }

        const meta = {
            id: lookupId,
            type: item.type,
            name: item.type === 'series' ? item.title.replace(/ Season \d+/, '') : item.title,
            logo: logoUrl,
            poster: poster,
            description: description,
            releaseInfo: item.releaseYear || (tmdbData.release_date ? tmdbData.release_date.split('-')[0] : (tmdbData.first_air_date ? tmdbData.first_air_date.split('-')[0] : 'N/A')),
            imdbRating: rpdbData.imdb?.rating || omdbData.imdbRating || 'N/A',
            rottenTomatoesRating: rpdbData.rotten_tomatoes?.rating || 'N/A',
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
            rottenTomatoesRating: 'N/A',
            genres: item.genres ? item.genres.map(g => g.name) : ['Action', 'Adventure']
        };
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
            name: "MCU Chronologically Order",
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

// Manifest padrão
app.get('/manifest.json', (req, res) => {
    console.log('Default manifest requested');
    
    const manifest = {
        id: "com.joaogonp.marveladdon",
        name: "Marvel Teste",
        description: "Watch the entire Marvel catalog! MCU and X-Men (chronologically organized), Movies, Series, and Animations!",
        version: "1.2.0",
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

// Manifest personalizado
app.get('/catalog/:catalogsParam/manifest.json', (req, res) => {
    const catalogsParam = req.params.catalogsParam;
    const selectedCatalogIds = catalogsParam ? decodeURIComponent(catalogsParam).split(',').filter(id => !id.startsWith('rpdb_')) : [];
    console.log(`Custom catalog manifest requested - Selected catalogs: ${selectedCatalogIds.join(', ')}`);
    
    const allCatalogs = getAllCatalogs();
    let filteredCatalogs = allCatalogs;
    
    if (selectedCatalogIds.length > 0) {
        filteredCatalogs = allCatalogs.filter(catalog => selectedCatalogIds.includes(catalog.id));
    }
    
    const manifest = {
        id: "com.joaogonp.marveladdon.custom",
        name: "Marvel Teste Custom",
        description: "Your personalized Marvel catalog! MCU and X-Men (chronologically organized), Movies, Series, and Animations!",
        version: "1.2.0",
        logo: "https://raw.githubusercontent.com/joaogonp/addon-marvel/main/assets/icon.png",
        background: "https://raw.githubusercontent.com/joaogonp/addon-marvel/main/assets/background.jpg",
        catalogs: filteredCatalogs,
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

// Endpoint para informações de catálogos
app.get('/api/catalogs', (req, res) => {
    console.log('Catalog info requested');
    
    const catalogInfo = [
        { 
            id: 'marvel-mcu', 
            name: 'MCU Chronologically Order', 
            category: 'Timeline',
            description: 'Browse the Marvel Cinematic Universe in chronological story order',
            icon: 'calendar-alt'
        },
        { 
            id: 'xmen', 
            name: 'X-Men', 
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
                dataSourceName = 'MCU Chronologically Order';
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
        
        // Aplicar ordenação se especificado
        if (genre === 'old') {
            dataSource = sortByReleaseDate([...dataSource], 'asc');
            console.log(`${dataSourceName} - Applying sort: asc (old to new)`);
        } else if (genre === 'new') {
            dataSource = sortByReleaseDate([...dataSource], 'desc');
            console.log(`${dataSourceName} - Applying sort: desc (new to old)`);
        } else if (id === 'animations' && !genre) {
            // Para 'animations', default é 'old' conforme o manifest
            dataSource = sortByReleaseDate([...dataSource], 'asc');
            console.log(`${dataSourceName} - Applying default sort: asc (old to new)`);
        } else {
            console.log(`${dataSourceName} - Using default order from data`);
        }
    } catch (error) {
        console.error(`❌ Error loading data for catalog ID ${id}:`, error.message);
        return res.json({ metas: [] });
    }
    
    console.log(`⏳ Generating catalog for ${dataSourceName}...`);
    const metas = await Promise.all(
        dataSource.map(item => fetchAdditionalData(item, null))
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
    
    const rpdbKey = extractRpdbKey(catalogsParam);
    if (rpdbKey) {
        console.log(`RPDB API Key detected in catalogsParam: ${rpdbKey.substring(0, 4)}...`);
    }

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
                dataSourceName = 'MCU Chronologically Order';
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
            // Para 'animations', default é 'old' conforme o manifest
            dataSource = sortByReleaseDate([...dataSource], 'asc');
            console.log(`${dataSourceName} - Applying default sort: asc (old to new)`);
        } else {
            console.log(`${dataSourceName} - Using default order from data`);
        }
    } catch (error) {
        console.error(`❌ Error loading data for catalog ID ${id}:`, error.message);
        return res.json({ metas: [] });
    }
    
    console.log(`⏳ Generating catalog for ${dataSourceName}...`);
    const metas = await Promise.all(
        dataSource.map(item => fetchAdditionalData(item, rpdbKey))
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
    console.log(`Marvel Teste Addon server running at http://localhost:${port}/`);
    console.log(`Configuration page: http://localhost:${port}/configure`);
    console.log(`To install with custom catalogs: http://localhost:${port}/catalog/CATALOG_IDS/manifest.json`);
});

// Exportar função para testes
module.exports = { fetchAdditionalData };
