const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const chronologicalData = require('../Data/chronologicalData'); // Dados em ordem cronológica
const releaseData = require('../Data/releaseData'); // Dados em ordem de lançamento
const moviesData = require('../Data/moviesData'); // Dados dos Filmes
const seriesData = require('../Data/seriesData'); // Dados das Series
const animationsData = require('../Data/animationsData'); // Dados das animações
const xmenData = require('../Data/xmenData'); // Dados X-Men
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

    // Prioriza o poster definido no item ou no TMDB, em vez do Cinemeta
    let poster = null;
    if (item.poster) {
      // Usa sempre o poster manual
      poster = item.poster;
    } else if (tmdbData.poster_path) {
      // Se não tiver no ficheiro, usa o poster do TMDB
      poster = `https://image.tmdb.org/t/p/w500${tmdbData.poster_path}`;
    } else if (omdbData.Poster && omdbData.Poster !== 'N/A') {
      // Caso não tenha poster no TMDB, usa o do OMDb
      poster = omdbData.Poster;
    } else {
      // Fallback fixo
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
    return null; // Retorna null para itens com erro, será filtrado depois
  }
}

// Função para ordenar os dados de acordo com a data de lançamento
function sortByReleaseDate(data, order = 'desc') {
  return data.sort((a, b) => {
    const dateA = new Date(a.releaseYear);
    const dateB = new Date(b.releaseYear);
    
    if (order === 'asc') {
      return dateA - dateB; // Novo para Velho
    } else {
      return dateB - dateA; // Velho para Novo
    }
  });
}

// Modificar o catalogHandler
builder.defineCatalogHandler(async ({ type, id }) => {
  console.log(`Catalog requested - Type: ${type}, ID: ${id}`);

  // Retorna o catálogo em cache, se disponível
  if (cachedCatalog[id]) {
    console.log(`✅ Retornando catálogo do cache para ID: ${id}`);
    return cachedCatalog[id];
  }

  let dataSource;

  // Escolher a fonte de dados com base no id
  if (id === 'marvel-mcu') {
    dataSource = chronologicalData; // Dados em ordem cronológica
  } else if (id === 'release-order') {
    dataSource = releaseData; // Dados na ordem de lançamento
  } else if (id === 'xmen') {
    dataSource = xmenData; // Dados de X-Men
  } else if (id === 'movies') {
    dataSource = moviesData; // Dados de filmes
  } else if (id === 'series') {
    dataSource = seriesData; // Dados de séries
  } else if (id === 'animations') {
    dataSource = animationsData; // Dados de animações
  } else {
    return Promise.resolve({ metas: [] }); // Retorna vazio se o ID não for reconhecido
  }

  // Ordena os dados dependendo da categoria "new" ou "old"
  let sortedData;
  if (id === 'release-order') {
    const order = type === 'new' ? 'asc' : 'desc'; // "new" para crescente, "old" para decrescente
    sortedData = sortByReleaseDate(dataSource, order);
  } else {
    sortedData = dataSource;
  }

  // Processa os dados para gerar o catálogo
  const metas = await Promise.all(
    sortedData.map(fetchAdditionalData)
  );

  // Filtra itens nulos (que falharam ao buscar dados)
  const validMetas = metas.filter(item => item !== null);
  console.log(`✅ Catálogo gerado com ${validMetas.length} itens para ID: ${id}`);

  // Armazena o catálogo em cache por ID
  cachedCatalog[id] = { metas: validMetas };

  return cachedCatalog[id];
});

// Configuração do servidor
console.log('Initializing addon interface...');
const addonInterface = builder.getInterface();

console.log('Starting server...');
serveHTTP(addonInterface, {
  port,
  beforeMiddleware: app // aplica compression e cache
});
