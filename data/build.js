// Script de build: combina as malhas geográficas oficiais do IBGE com os
// nomes oficiais (estados, mesorregiões e municípios) e gera os arquivos
// GeoJSON finais usados pela aplicação. Executar apenas quando os dados
// brutos em data/raw/ forem atualizados: `node data/build.js`
'use strict';

const fs = require('fs');
const path = require('path');

const RAW = path.join(__dirname, 'raw');
const OUT = __dirname;

function readJSON(file) {
  return JSON.parse(fs.readFileSync(path.join(RAW, file), 'utf8'));
}

// Reduz a precisão das coordenadas (5 casas decimais ~ 1 metro) para
// diminuir o tamanho dos arquivos sem perda perceptível de qualidade visual.
function roundCoords(coords) {
  if (typeof coords[0] === 'number') {
    return coords.map((n) => Math.round(n * 100000) / 100000);
  }
  return coords.map(roundCoords);
}

function slimGeometry(geom) {
  return { type: geom.type, coordinates: roundCoords(geom.coordinates) };
}

// --- Estados (UF) -----------------------------------------------------
const estados = readJSON('estados.json');
const estadosById = new Map(estados.map((e) => [String(e.id), e]));
const ufMalha = readJSON('uf_malha.json');

const estadosFeatures = ufMalha.features.map((f) => {
  const cod = f.properties.codarea;
  const e = estadosById.get(cod);
  return {
    type: 'Feature',
    properties: {
      codigo: cod,
      sigla: e ? e.sigla : null,
      nome: e ? e.nome : null,
      regiao: e ? e.regiao.nome : null,
    },
    geometry: slimGeometry(f.geometry),
  };
});

fs.writeFileSync(
  path.join(OUT, 'estados.geojson'),
  JSON.stringify({ type: 'FeatureCollection', features: estadosFeatures })
);
console.log(`estados.geojson: ${estadosFeatures.length} features`);

// --- Mesorregiões -------------------------------------------------------
const mesorregioes = readJSON('mesorregioes.json');
const mesoById = new Map(mesorregioes.map((m) => [String(m.id), m]));
const mesoMalha = readJSON('meso_malha.json');

const mesoFeatures = mesoMalha.features.map((f) => {
  const cod = f.properties.codarea;
  const m = mesoById.get(cod);
  return {
    type: 'Feature',
    properties: {
      codigo: cod,
      nome: m ? m.nome : null,
      uf_sigla: m ? m.UF.sigla : null,
      uf_codigo: m ? String(m.UF.id) : null,
    },
    geometry: slimGeometry(f.geometry),
  };
});

fs.writeFileSync(
  path.join(OUT, 'mesorregioes.geojson'),
  JSON.stringify({ type: 'FeatureCollection', features: mesoFeatures })
);
console.log(`mesorregioes.geojson: ${mesoFeatures.length} features`);

// --- Municípios -----------------------------------------------------------
const municipios = readJSON('municipios.json');
const munById = new Map(municipios.map((m) => [String(m.id), m]));
const munMalha = readJSON('mun_malha.json');

const munFeatures = munMalha.features.map((f) => {
  const cod = f.properties.codarea;
  const m = munById.get(cod);
  const meso = m ? m.microrregiao.mesorregiao : null;
  return {
    type: 'Feature',
    properties: {
      codigo: cod,
      nome: m ? m.nome : null,
      uf_sigla: meso ? meso.UF.sigla : null,
      uf_codigo: meso ? String(meso.UF.id) : null,
      meso_codigo: meso ? String(meso.id) : null,
      meso_nome: meso ? meso.nome : null,
    },
    geometry: slimGeometry(f.geometry),
  };
});

fs.writeFileSync(
  path.join(OUT, 'municipios.geojson'),
  JSON.stringify({ type: 'FeatureCollection', features: munFeatures })
);
console.log(`municipios.geojson: ${munFeatures.length} features`);
