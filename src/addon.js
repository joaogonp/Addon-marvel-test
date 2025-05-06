const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const chronologicalData = require('../Data/chronologicalData');
const releaseData = require('../Data/releaseData');
const moviesData = require('../Data/moviesData');
const seriesData = require('../Data/seriesData');
const animationsData = require('../Data/animationsData');
const xmenData = require('../Data/xmenData');
const { tmdbKey, omdbKey, port } = require('./config');

const express = require('express');
const compression = require('compression');

const app = express();
app.use(compression());

// Middleware para definir cache de 3 semanas
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'public, max-age=2629743'); // 3 semanas
  next();
});

// Inicialização do add-on
console.log('Starting Marvel Addon v1.0.1...');
const builder = new addonBuilder(require('./manifest.json'));

// Variável para armazenar o cache separado por ID
let cachedCatalog = {};

// Função para buscar dados adicionais (OMDb e TMDb)
async function fetchAdditionalData(item) {
  try {
    const omdbUrl = `http://www.omdbapi.com/?i=${item.imdbId}&apikey=${omdbKey}`;
    const tmdbSearchUrl = `https://api.themoviedb.org/3/search/${item.type === 'movie' ? 'movie' : 'tv'}?api_key=${tmdbKey}&query=${encodeURIComponent(item.title)}&year=${item.releaseYear}`;

    console.log(`Fetching data for ${item.title} (${item.imdbId})...`);
    const [omdbRes, tmdbRes] = await Promise.all([
      axios.get(omdbUrl).catch((err) => {
        console.error(`OMDB error for ${item.imdbId}: ${err.message}`);
        return {};
      }),
      axios.get(tmdbSearchUrl).catch((err) => {
        console.error(`TMDB error for ${item.title}: ${err.message}`);
        return {};
      })
    ]);

    const omdbData = omdbRes.data || {};
    const tmdbData = tmdbRes.data?.results?.[0] || {};

    let poster = null;
    if (item.poster) {
      poster = item.poster;
    } else if (tmdbData.poster_path) {
      poster = `https://image.tmdb.org/t/p/w500${tmdbData.poster_path}`;
    } else if (omdbData.Poster && omdbData.Poster !== 'N/A') {
      poster = omdbData.Poster;
    } else {
      poster = 'https://m.media-amazon.com/images/M/MV5BMTc5MDE2ODcwNV5BMl5BanBnXkFtZTgwMzI2NzQ2NzM@._V1_SX300.jpg';
      console.warn(`No poster found for ${item.title} (${item.imdbId}), using fallback.`);
    }

    return {
      id: item.imdbId,
      type: item.type,
      name: item.type === 'series' ? item.title.replace(/ Season \d+/, '') : item.title,
      poster: poster,
      description: tmdbData.overview || omdbData.Plot || 'No description available',
      releaseInfo: item.releaseYear,
      imdbRating: omdbData.imdbRating || 'N/A',
      genres: tmdbData.genres ? tmdbData.genres.map(g => g.name) : ['Action', 'Adventure']
    };
  } catch (err) {
    console.error(`Error processing ${item.title} (${item.imdbId}): ${err.message}`);
    return null;
  }
}

// Função para ordenar dados por data de lançamento
function sortByReleaseDate(data, order = 'desc') {
  return data.sort((a, b) => {
    const dateA = new Date(a.releaseInfo);
    const dateB = new Date(b.releaseInfo);
    return order === 'asc' ? dateA - dateB : dateB - dateA;
  });
}

// Definição do catálogo
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  console.log(`Catalog requested - Type: ${type}, ID: ${id}, Extra: ${JSON.stringify(extra)}`);

  if (cachedCatalog[id] && (!extra || !extra.subcategory)) {
    console.log(`✅ Retornando catálogo do cache para ID: ${id}`);
    return cachedCatalog[id];
  }

  let dataSource;
  if (id === 'marvel-mcu') {
    dataSource = chronologicalData;
  } else if (id === 'release-order') {
    dataSource = releaseData;
  } else if (id === 'xmen') {
    dataSource = xmenData;
  } else if (id === 'movies') {
    dataSource = moviesData;
  } else if (id === 'series') {
    dataSource = seriesData;
  } else if (id === 'animations') {
    dataSource = animationsData;
  } else {
    return Promise.resolve({ metas: [] });
  }

  // Filtra por subcategoria se fornecida
  let filteredData = [...dataSource];
  if (id === 'release-order' && extra?.subcategory) {
    if (extra.subcategory === 'new') {
      // Filtra para itens "new" (exemplo: filmes lançados após 2019)
      filteredData = filteredData.filter(item => new Date(item.releaseInfo) > new Date('2019-01-01'));
    } else if (extra.subcategory === 'old') {
      // Filtra para itens "old" (exemplo: filmes lançados antes de 2019)
      filteredData = filteredData.filter(item => new Date(item.releaseInfo) <= new Date('2019-01-01'));
    }
  }

  // Ordena os dados se for "release-order"
  const sortOrder = extra?.sortOrder || 'desc';
  const sortedData = id === 'release-order' ? sortByReleaseDate(filteredData, sortOrder) : filteredData;

  // Processa os dados para gerar o catálogo
  const metas = await Promise.all(sortedData.map(fetchAdditionalData));
  const validMetas = metas.filter(item => item !== null);
  console.log(`✅ Catálogo gerado com ${validMetas.length} itens para ID: ${id}`);

  // Armazena o catálogo em cache por ID e subcategoria (se aplicável)
  const cacheKey = id + (extra?.subcategory ? `_${extra.subcategory}` : '');
  cachedCatalog[cacheKey] = { metas: validMetas };

  return cachedCatalog[cacheKey];
});

// Configuração do servidor
console.log('Initializing addon interface...');
const addonInterface = builder.getInterface();

console.log('Starting server...');
serveHTTP(addonInterface, {
  port,
  beforeMiddleware: app
});
