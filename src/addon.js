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

// Variável para armazenar o cache separado por ID e subcatalog
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
      releaseInfo: item.releaseInfo || item.releaseYear,
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
    const dateA = new Date(a.releaseInfo || a.releaseYear);
    const dateB = new Date(b.releaseInfo || b.releaseYear);
    return order === 'asc' ? dateA - dateB : dateB - dateA;
  });
}

// Definição do catálogo
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  console.log(`Catalog requested - Type: ${type}, ID: ${id}, Extra: ${JSON.stringify(extra)}`);

  const cacheKey = id + (extra?.subcatalog ? `_${extra.subcatalog}` : (extra?.sort ? `_${extra.sort}` : ''));
  if (cachedCatalog[cacheKey]) {
    console.log(`✅ Retornando catálogo do cache para ID: ${cacheKey}`);
    return cachedCatalog[cacheKey];
  }

  let dataSource;
  if (type === 'Marvel' && id === 'marvel-mcu') {
    dataSource = chronologicalData;
  } else if (type === 'Marvel' && id === 'release-order') {
    dataSource = releaseData;
    if (extra?.subcatalog === 'old') {
      dataSource = sortByReleaseDate([...dataSource], 'asc');
      console.log('Applying sort: asc (old)');
    } else if (extra?.subcatalog === 'new' || !extra?.subcatalog) {
      dataSource = sortByReleaseDate([...dataSource], 'desc');
      console.log('Applying sort: desc (new or default)');
    }
  } else if (type === 'Marvel' && id === 'xmen') {
    dataSource = xmenData;
  } else if (type === 'Marvel' && id === 'movies') {
    dataSource = moviesData;
  } else if (type === 'Marvel' && id === 'series') {
    dataSource = seriesData;
  } else if (type === 'Marvel' && id === 'animations') {
    dataSource = animationsData;
  } else {
    return Promise.resolve({ metas: [] });
  }

  const metas = await Promise.all(dataSource.map(fetchAdditionalData));
  const validMetas = metas.filter(item => item !== null);
  console.log(`✅ Catálogo gerado com ${validMetas.length} itens for ID: ${id}, Subcatalog: ${extra?.subcatalog || 'default'}`);

  cachedCatalog[cacheKey] = { metas: validMetas };
  return cachedCatalog[cacheKey];
});

// Configuração do servidor
