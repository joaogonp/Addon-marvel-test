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
    console.error('Erro ao carregar config.js. Usando variáveis de ambiente.', error);
    port = process.env.PORT || 7000;
    tmdbKey = process.env.TMDB_API_KEY;
    omdbKey = process.env.OMDB_API_KEY;
    
    if (!tmdbKey || !omdbKey) {
        console.error('CRÍTICO: Chaves de API (TMDB_API_KEY, OMDB_API_KEY) estão faltando. O addon não pode buscar metadados.');
    }
}

const app = express();

// Middleware
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Cache por 3 semanas
app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'public, max-age=1814400');
    next();
});

// Health check para o Render
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Rota para servir configure.html para caminhos como /catalog/id1,id2/configure
app.get('/catalog/:ids/configure', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

// Rota para a página de configuração
app.get('/configure', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

// Variável para armazenar cache separado por ID
let cachedCatalog = {};

// Função auxiliar para buscar detalhes do TMDb
async function getTmdbDetails(id, type) {
    const url = `https://api.themoviedb.org/3/${type}/${id}?api_key=${tmdbKey}&language=en-US&append_to_response=external_ids`;
    try {
        const res = await axios.get(url);
        return res;
    } catch (err) {
        console.error(`Erro ao buscar detalhes do TMDb para ${type}/${id}: ${err.message}`);
        return {};
    }
}

// Função auxiliar para substituir posters por posters do RPDB quando uma chave válida é fornecida
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

// Função para buscar metadados adicionais
async function fetchAdditionalData(item) {
    console.log('\n--- Buscando detalhes para o item: ---', item);

    // Validação básica do item
    if (!item || (!item.imdbId && !item.id) || !item.type || !item.title) {
        console.warn('Ignorando item devido a dados essenciais ausentes:', item);
        return null;
    }
    const lookupId = item.imdbId || item.id;
    const idPrefix = lookupId.split('_')[0];
    const isImdb = idPrefix === 'tt' || (item.imdbId && !item.imdbId.startsWith('tmdb_'));

    // Verificar se as chaves de API estão disponíveis
    if (!tmdbKey || (!omdbKey && isImdb)) {
        console.warn(`Ignorando busca de metadados para ${item.title} (${lookupId}) porque as chaves de API estão faltando.`);
        return {
            id: lookupId,
            type: item.type,
            name: item.type === 'series' ? item.title.replace(/ Season \d+/, '') : item.title,
            poster: item.poster || 'https://m.media-amazon.com/images/M/MV5BMTc5MDE2ODcwNV5BMl5BanBnXkFtZTgwMzI2NzQ2NzM@._V1_SX300.jpg',
            description: item.overview || 'Busca de metadados indisponível (chave de API ausente).',
            releaseInfo: item.releaseYear || 'N/A',
            imdbRating: 'N/A',
            genres: item.genres ? item.genres.map(g => g.name) : ['Action', 'Adventure']
        };
    }

    let omdbData = {};
    let tmdbData = {};
    let tmdbImagesData = {};

    try {
        // Chamada ao OMDb apenas se tivermos um ID IMDb real
        const omdbPromise = isImdb
            ? axios.get(`http://www.omdbapi.com/?i=${lookupId}&apikey=${omdbKey}`).catch((err) => {
                  console.error(`Erro no OMDb para ${lookupId}: ${err.message}`);
                  return {};
              })
            : Promise.resolve({});

        // Chamada de busca/detalhes do TMDb
        let effectiveTmdbId = item.tmdbId || (idPrefix === 'tmdb' ? lookupId.split('_')[1] : null);
        let tmdbDetailsPromise;
        if (effectiveTmdbId) {
            const tmdbDetailsUrl = `https://api.themoviedb.org/3/${item.type}/${effectiveTmdbId}?api_key=${tmdbKey}&language=en-US`;
            tmdbDetailsPromise = axios.get(tmdbDetailsUrl).catch((err) => {
                console.error(`Erro nos detalhes do TMDb para ${item.type}/${effectiveTmdbId}: ${err.message}`);
                return {};
            });
        } else {
            const tmdbSearchUrl = `https://api.themoviedb.org/3/search/${item.type}?api_key=${tmdbKey}&query=${encodeURIComponent(item.title)}&year=${item.releaseYear}`;
            tmdbDetailsPromise = axios.get(tmdbSearchUrl).then(res =>
                res.data?.results?.[0] ? getTmdbDetails(res.data.results[0].id, item.type) : {}
            ).catch((err) => {
                console.error(`Erro na busca do TMDb para ${item.title}: ${err.message}`);
                return {};
            });
        }

        // Buscar imagens usando o ID do TMDb
        const tmdbImagesPromise = tmdbDetailsPromise.then(detailsRes => {
            const foundTmdbId = detailsRes?.data?.id || effectiveTmdbId;
            if (foundTmdbId) {
                const tmdbImagesUrl = `https://api.themoviedb.org/3/${type}/${foundTmdbId}/images?api_key=${tmdbKey}`;
                return axios.get(tmdbImagesUrl).catch((err) => {
                    if (!err.response || err.response.status !== 404) {
                        console.warn(`Erro nas imagens do TMDb para ${item.title}: ${err.message}`);
                    }
                    return {};
                });
            } else {
                return Promise.resolve({});
            }
        });

        console.log(`Buscando dados para ${item.title} (${lookupId})...`);
        const [omdbRes, tmdbDetailsResult, tmdbImagesRes] = await Promise.all([
            omdbPromise,
            tmdbDetailsPromise,
            tmdbImagesPromise
        ]);

        omdbData = omdbRes.data || {};
        tmdbData = tmdbDetailsResult.data || {};
        tmdbImagesData = tmdbImagesRes.data || {};

        // Prioridade do poster: local -> TMDb -> OMDb -> fallback
        let poster = item.poster || null;
        if (!poster && tmdbData.poster_path) {
            poster = `https://image.tmdb.org/t/p/w500${tmdbData.poster_path}`;
        }
        if (!poster && omdbData.Poster && omdbData.Poster !== 'N/A') {
            poster = omdbData.Poster;
        }
        if (!poster) {
            poster = 'https://m.media-amazon.com/images/M/MV5BMTc5MDE2ODcwNV5BMl5BanBnXkFtZTgwMzI2NzQ2NzM@._V1_SX300.jpg';
            console.warn(`Nenhum poster válido encontrado para ${item.title} (${lookupId}), usando fallback.`);
        }

        let logoUrl = null;
        if (tmdbImagesData.logos && tmdbImagesData.logos.length > 0) {
            let bestLogo = tmdbImagesData.logos.find(logo => logo.iso_639_1 === 'en') || tmdbImagesData.logos[0];
            if (bestLogo && bestLogo.file_path) {
                logoUrl = `https://image.tmdb.org/t/p/original${bestLogo.file_path}`;
            }
        }

        const description = item.overview || tmdbData.overview || omdbData.Plot || 'Nenhuma descrição disponível.';

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

        console.log('   > Retornando metadados:', { ...meta, description: meta.description.substring(0, 50) + '...' });
        return meta;
    } catch (err) {
        console.error(`Erro ao processar ${item.title} (${lookupId}): ${err.message}`);
        return {
            id: lookupId,
            type: item.type,
            name: item.type === 'series' ? item.title.replace(/ Season \d+/, '') : item.title,
            poster: item.poster || 'https://m.media-amazon.com/images/M/MV5BMTc5MDE2ODcwNV5BMl5BanBnXkFtZTgwMzI2NzQ2NzM@._V1_SX300.jpg',
            description: item.overview || 'Nenhuma descrição disponível.',
            releaseInfo: item.releaseYear || 'N/A',
            imdbRating: 'N/A',
            genres: item.genres ? item.genres.map(g => g.name) : ['Action', 'Adventure']
        };
    }
}

// Função para ordenar dados por data de lançamento
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
            name: "MCU Chronologicamente Ordenado",
            extra: [
                {
                    name: "genre",
                    options: ["new", "old"],
                    isRequired: false,
                    default: null,
                    optionLabels: {
                        new: "Novo para Antigo",
                        old: "Antigo para Novo"
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
            name: "Filmes",
            extra: [
                {
                    name: "genre",
                    options: ["new"],
                    isRequired: false,
                    default: null,
                    optionLabels: {
                        new: "Novo para Antigo"
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
            name: "Séries",
            extra: [
                {
                    name: "genre",
                    options: ["new"],
                    isRequired: false,
                    default: null,
                    optionLabels: {
                        new: "Novo para Antigo"
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
            name: "Animações",
            extra: [
                {
                    name: "genre",
                    options: ["new", "old"],
                    isRequired: false,
                    default: "old",
                    optionLabels: {
                        new: "Novo para Antigo",
                        old: "Antigo para Novo"
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
    console.log('Manifest padrão solicitado');
    
    const rpdbKey = req.query.rpdb || null;
    if (rpdbKey) {
        console.log(`Manifest padrão com chave RPDB: ${rpdbKey.substring(0, 4)}...`);
    }
    
    const manifestId = rpdbKey 
        ? "com.joaogonp.marveladdon.rpdb"
        : "com.joaogonp.marveladdon";
    
    const manifest = {
        id: manifestId,
        name: "Marvel Teste",
        description: "Assista ao catálogo completo da Marvel! MCU e X-Men (organizados cronologicamente), Filmes, Séries e Animações!",
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

// Manifest baseado em RPDB
app.get('/rpdb/:rpdbKey/manifest.json', (req, res) => {
    const { rpdbKey } = req.params;
    console.log(`Manifest baseado em RPDB solicitado com chave: ${rpdbKey.substring(0, 4)}...`);
    
    const manifestId = `com.joaogonp.marveladdon.rpdb.${rpdbKey.substring(0, 8)}`;
    
    const manifest = {
        id: manifestId,
        name: "Marvel Teste",
        description: "Assista ao catálogo completo da Marvel com avaliações do IMDb nos posters! MCU e X-Men (organizados cronologicamente), Filmes, Séries e Animações!",
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

// Manifest de catálogo personalizado
app.get('/catalog/:catalogsParam/manifest.json', (req, res) => {
    const { catalogsParam } = req.params;
    
    let rpdbKey = null;
    let selectedCatalogIds = catalogsParam;
    
    if (catalogsParam.includes(':')) {
        const parts = catalogsParam.split(':');
        selectedCatalogIds = parts[0];
        rpdbKey = parts[1];
        console.log(`Manifest personalizado com chave RPDB: ${rpdbKey.substring(0, 4)}...`);
        selectedCatalogIds = selectedCatalogIds.split(',').map(id => id.trim());
    } else {
        selectedCatalogIds = catalogsParam.split(',').map(id => id.trim());
    }

    const allCatalogs = getAllCatalogs();
    const selectedApiCatalogs = allCatalogs.filter(catalog => selectedCatalogIds.includes(catalog.id));
    
    if (selectedApiCatalogs.length === 0) {
        return res.status(404).send('Nenhum catálogo válido selecionado ou encontrado.');
    }
    
    const customId = rpdbKey 
        ? `com.joaogonp.marveladdon.custom.${selectedCatalogIds.join('.')}.rpdb`
        : `com.joaogonp.marveladdon.custom.${selectedCatalogIds.join('.')}`;
    
    const manifestId = customId.slice(0, 100);
    
    const manifest = {
        id: manifestId,
        name: "Marvel Teste Personalizado",
        description: `Seu catálogo personalizado da Marvel: ${selectedApiCatalogs.map(c => c.name).join(', ')}`,
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

// Endpoint para informações de catálogos
app.get('/api/catalogs', (req, res) => {
    console.log('Informações de catálogos solicitadas');
    
    const catalogInfo = [
        { 
            id: 'marvel-mcu', 
            name: 'MCU Chronologicamente Ordenado', 
            category: 'Linha do Tempo',
            description: 'Navegue pelo Universo Cinematográfico da Marvel em ordem cronológica da história',
            icon: 'calendar-alt'
        },
        { 
            id: 'xmen', 
            name: 'X-Men', 
            category: 'Personagem',
            description: 'Todos os filmes e conteúdos relacionados aos X-Men',
            icon: 'mask'
        },
        { 
            id: 'movies', 
            name: 'Filmes', 
            category: 'Tipo de Conteúdo',
            description: 'Todos os filmes da Marvel em diferentes franquias',
            icon: 'film'
        },
        { 
            id: 'series', 
            name: 'Séries', 
            category: 'Tipo de Conteúdo',
            description: 'Todas as séries de televisão da Marvel',
            icon: 'tv'
        },
        { 
            id: 'animations', 
            name: 'Animações', 
            category: 'Tipo de Conteúdo',
            description: 'Todos os recursos animados e séries da Marvel',
            icon: 'play-circle'
        }
    ];
    
    res.json(catalogInfo);
});

// Endpoint de catálogo baseado em RPDB
app.get('/rpdb/:rpdbKey/catalog/:type/:id.json', async (req, res) => {
    const { rpdbKey, type, id } = req.params;
    const genre = req.query.genre;
    console.log(`Catálogo baseado em RPDB solicitado - Tipo: ${type}, ID: ${id}, Chave RPDB: ${rpdbKey.substring(0, 4)}..., Gênero: ${genre || 'padrão'}`);
    
    const cacheKey = `default-${id}${genre ? `_${genre}` : ''}`;
    if (cachedCatalog[cacheKey]) {
        console.log(`✅ Retornando catálogo em cache para ID: ${cacheKey} com posters RPDB`);
        const metasWithRpdbPosters = replaceRpdbPosters(rpdbKey, cachedCatalog[cacheKey].metas);
        return res.json({ metas: metasWithRpdbPosters });
    }
    
    let dataSource;
    let dataSourceName = id;
    
    try {
        switch (id) {
            case 'marvel-mcu':
                dataSource = chronologicalData;
                dataSourceName = 'MCU Chronologicamente Ordenado';
                break;
            case 'xmen':
                dataSource = xmenData;
                dataSourceName = 'X-Men';
                break;
            case 'movies':
                dataSource = moviesData;
                dataSourceName = 'Filmes';
                break;
            case 'series':
                dataSource = seriesData;
                dataSourceName = 'Séries';
                break;
            case 'animations':
                dataSource = animationsData;
                dataSourceName = 'Animações';
                break;
            default:
                console.warn(`ID de catálogo não reconhecido: ${id}`);
                return res.json({ metas: [] });
        }
        
        if (!Array.isArray(dataSource)) {
            throw new Error(`Fonte de dados para ID ${id} não é um array válido.`);
        }
        console.log(`Carregados ${dataSource.length} itens para o catálogo: ${dataSourceName}`);
        
        if (genre === 'old') {
            dataSource = sortByReleaseDate([...dataSource], 'asc');
            console.log(`${dataSourceName} - Aplicando ordenação: asc (antigo para novo)`);
        } else if (genre === 'new') {
            dataSource = sortByReleaseDate([...dataSource], 'desc');
            console.log(`${dataSourceName} - Aplicando ordenação: desc (novo para antigo)`);
        } else if (id === 'animations' && !genre) {
            dataSource = sortByReleaseDate([...dataSource], 'asc');
            console.log(`${dataSourceName} - Aplicando ordenação padrão: asc (antigo para novo)`);
        } else {
            console.log(`${dataSourceName} - Usando ordem padrão dos dados`);
        }
    } catch (error) {
        console.error(`❌ Erro ao carregar dados para o ID de catálogo ${id}:`, error.message);
        return res.json({ metas: [] });
    }
    
    console.log(`⏳ Gerando catálogo para ${dataSourceName} com posters RPDB...`);
    const metas = await Promise.all(
        dataSource.map(item => fetchAdditionalData(item))
    );
    
    const validMetas = metas.filter(item => item !== null);
    console.log(`✅ Catálogo gerado com ${validMetas.length} itens para ID: ${id}`);
    
    cachedCatalog[cacheKey] = { metas: validMetas };
    
    const metasWithRpdbPosters = replaceRpdbPosters(rpdbKey, validMetas);
    return res.json({ metas: metasWithRpdbPosters });
});

// Endpoint de catálogo personalizado
app.get('/catalog/:catalogsParam/catalog/:type/:id.json', async (req, res) => {
    const { catalogsParam, type, id } = req.params;
    const genre = req.query.genre;
    console.log(`Catálogo personalizado solicitado - Catálogos: ${catalogsParam}, Tipo: ${type}, ID: ${id}, Gênero: ${genre || 'padrão'}`);
    
    let rpdbKey = null;
    let catalogIds = catalogsParam;
    
    if (catalogsParam.includes(':')) {
        const parts = catalogsParam.split(':');
        catalogIds = parts[0];
        rpdbKey = parts[1];
        console.log(`Chave RPDB detectada: ${rpdbKey.substring(0, 4)}...`);
    }
    
    const cacheKey = `custom-${id}-${catalogsParam}${genre ? `_${genre}` : ''}`;
    if (cachedCatalog[cacheKey]) {
        console.log(`✅ Retornando catálogo em cache para ID: ${cacheKey}`);
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
                dataSourceName = 'MCU Chronologicamente Ordenado';
                break;
            case 'xmen':
                dataSource = xmenData;
                dataSourceName = 'X-Men';
                break;
            case 'movies':
                dataSource = moviesData;
                dataSourceName = 'Filmes';
                break;
            case 'series':
                dataSource = seriesData;
                dataSourceName = 'Séries';
                break;
            case 'animations':
                dataSource = animationsData;
                dataSourceName = 'Animações';
                break;
            default:
                console.warn(`ID de catálogo não reconhecido: ${id}`);
                return res.json({ metas: [] });
        }
        
        if (!Array.isArray(dataSource)) {
            throw new Error(`Fonte de dados para ID ${id} não é um array válido.`);
        }
        console.log(`Carregados ${dataSource.length} itens para o catálogo: ${dataSourceName}`);
        
        if (genre === 'old') {
            dataSource = sortByReleaseDate([...dataSource], 'asc');
            console.log(`${dataSourceName} - Aplicando ordenação: asc (antigo para novo)`);
        } else if (genre === 'new') {
            dataSource = sortByReleaseDate([...dataSource], 'desc');
            console.log(`${dataSourceName} - Aplicando ordenação: desc (novo para antigo)`);
        } else if (id === 'animations' && !genre) {
            dataSource = sortByReleaseDate([...dataSource], 'asc');
            console.log(`${dataSourceName} - Aplicando ordenação padrão: asc (antigo para novo)`);
        } else {
            console.log(`${dataSourceName} - Usando ordem padrão dos dados`);
        }
    } catch (error) {
        console.error(`❌ Erro ao carregar dados para o ID de catálogo ${id}:`, error.message);
        return res.json({ metas: [] });
    }
    
    console.log(`⏳ Gerando catálogo para ${dataSourceName}...`);
    const metas = await Promise.all(
        dataSource.map(item => fetchAdditionalData(item))
    );
    
    const validMetas = metas.filter(item => item !== null);
    console.log(`✅ Catálogo gerado com ${validMetas.length} itens para ID: ${id}`);
    
    cachedCatalog[cacheKey] = { metas: validMetas };
    
    if (rpdbKey) {
        const metasWithRpdbPosters = replaceRpdbPosters(rpdbKey, validMetas);
        return res.json({ metas: metasWithRpdbPosters });
    }
    
    return res.json(cachedCatalog[cacheKey]);
});

// Endpoint de catálogo padrão
app.get('/catalog/:type/:id.json', async (req, res) => {
    const { type, id } = req.params;
    const genre = req.query.genre;
    console.log(`Catálogo padrão solicitado - Tipo: ${type}, ID: ${id}, Gênero: ${genre || 'padrão'}`);
    
    let rpdbKey = req.query.rpdb || null;
    const referer = req.get('Referrer') || '';
    if (!rpdbKey && referer) {
        const rpdbMatch = referer.match(/\/rpdb\/([^\/]+)\/manifest\.json/);
        if (rpdbMatch && rpdbMatch[1]) {
            rpdbKey = decodeURIComponent(rpdbMatch[1]);
        }
    }
    
    if (rpdbKey) {
        console.log(`Chave RPDB detectada: ${rpdbKey.substring(0, 4)}...`);
    }
    
    const cacheKey = `default-${id}${genre ? `_${genre}` : ''}`;
    if (cachedCatalog[cacheKey]) {
        console.log(`✅ Retornando catálogo em cache para ID: ${cacheKey}`);
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
                dataSourceName = 'MCU Chronologicamente Ordenado';
                break;
            case 'xmen':
                dataSource = xmenData;
                dataSourceName = 'X-Men';
                break;
            case 'movies':
                dataSource = moviesData;
                dataSourceName = 'Filmes';
                break;
            case 'series':
                dataSource = seriesData;
                dataSourceName = 'Séries';
                break;
            case 'animations':
                dataSource = animationsData;
                dataSourceName = 'Animações';
                break;
            default:
                console.warn(`ID de catálogo não reconhecido: ${id}`);
                return res.json({ metas: [] });
        }
        
        if (!Array.isArray(dataSource)) {
            throw new Error(`Fonte de dados para ID ${id} não é um array válido.`);
        }
        console.log(`Carregados ${dataSource.length} itens para o catálogo: ${dataSourceName}`);
        
        if (genre === 'old') {
            dataSource = sortByReleaseDate([...dataSource], 'asc');
            console.log(`${dataSourceName} - Aplicando ordenação: asc (antigo para novo)`);
        } else if (genre === 'new') {
            dataSource = sortByReleaseDate([...dataSource], 'desc');
            console.log(`${dataSourceName} - Aplicando ordenação: desc (novo para antigo)`);
        } else if (id === 'animations' && !genre) {
            dataSource = sortByReleaseDate([...dataSource], 'asc');
            console.log(`${dataSourceName} - Aplicando ordenação padrão: asc (antigo para novo)`);
        } else {
            console.log(`${dataSourceName} - Usando ordem padrão dos dados`);
        }
    } catch (error) {
        console.error(`❌ Erro ao carregar dados para o ID de catálogo ${id}:`, error.message);
        return res.json({ metas: [] });
    }
    
    console.log(`⏳ Gerando catálogo para ${dataSourceName}...`);
    const metas = await Promise.all(
        dataSource.map(item => fetchAdditionalData(item))
    );
    
    const validMetas = metas.filter(item => item !== null);
    console.log(`✅ Catálogo gerado com ${validMetas.length} itens para ID: ${id}`);
    
    cachedCatalog[cacheKey] = { metas: validMetas };
    
    if (rpdbKey) {
        const metasWithRpdbPosters = replaceRpdbPosters(rpdbKey, validMetas);
        return res.json({ metas: metasWithRpdbPosters });
    }
    
    return res.json(cachedCatalog[cacheKey]);
});

// Rotas padrão
app.get('/', (req, res) => {
    res.redirect('/configure');
});

app.listen(port, () => {
    console.log(`Servidor do Addon Marvel Teste rodando em http://localhost:${port}/`);
    console.log(`Página de configuração: http://localhost:${port}/configure`);
    console.log(`Para instalar com catálogos personalizados: http://localhost:${port}/catalog/CATALOG_IDS/manifest.json`);
});

// Exportar a função fetchAdditionalData para testes
module.exports = { fetchAdditionalData };
