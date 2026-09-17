// ============================================================================
// Mapa Interativo do Brasil — Estados, Mesorregiões e Municípios (IBGE)
// Aplicação em JavaScript puro + Leaflet.js. Todo o estado do projeto é
// mantido em memória e persistido no localStorage do navegador.
// ============================================================================

'use strict';

// ---------------------------------------------------------------------------
// Constantes e estado global
// ---------------------------------------------------------------------------

const CHAVE_LOCALSTORAGE = 'mapaBrasilProjeto_v1';

const CORES = {
  estadoContorno: '#000000',
  mesorregiaoContorno: '#f2994a',
  municipioContorno: '#c9cdd3',
  municipioContornoSelecionado: '#111111',
};

// Estado global da aplicação (tudo que é salvo no projeto)
let coresIndividuais = new Map();   // codigo do município -> cor hex
let municipioParaGrupo = new Map(); // codigo do município -> id do grupo
let grupos = [];                    // [{ id, nome, cor }]
let rotas = [];                     // [{ id, nome, cor, pontos:[[lat,lng]], layer }]
let marcadores = [];                // [{ id, lat, lng, titulo, texto, layer }]
let textos = [];                    // [{ id, lat, lng, texto, layer }]

// Estado transitório (não é salvo diretamente, é derivado)
let selecionados = new Set();       // códigos de municípios selecionados no momento
let modoAtual = 'selecionar';       // 'selecionar' | 'rota' | 'marcador' | 'texto'
let multiSelecaoAtiva = false;
let pontosRotaAtual = [];
let linhaRotaTemp = null;
let estadoFiltroAtual = null;       // código do estado (UF) em foco, ou null = visão geral

// Índices de dados carregados
const municipiosPorCodigo = new Map(); // codigo -> { feature, layer, nome, uf_sigla, meso_codigo, meso_nome }
const municipiosPorMesorregiao = new Map(); // meso_codigo -> Set de codigos de municipios
const mesorregioesInfo = new Map();         // meso_codigo -> { codigo, nome, uf_codigo, uf_sigla }
let listaBuscaMunicipios = [];
const boundsPorUF = new Map();         // código da UF -> L.LatLngBounds
let boundsBrasil = null;
let camadaEstadosGeo = null;
let camadaMesorregioesGeo = null;
const rotulosEstados = []; // [{ uf_codigo, marker }]
const rotulosMesorregioes = []; // [{ uf_codigo, marker }]

let contadorId = 1;
function proximoId() { return 'id' + (contadorId++) + '_' + Date.now().toString(36); }

// ---------------------------------------------------------------------------
// Modal genérico (substitui prompt()/confirm()/alert() nativos, que podem
// não estar disponíveis em alguns contextos de navegador embutido)
// ---------------------------------------------------------------------------

function abrirModal({ titulo = '', mensagem = '', comInput = false, valorPadrao = '', textoConfirmar = 'OK', apenasAviso = false }) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('modal-overlay');
    const input = document.getElementById('modal-input');
    const btnConfirmar = document.getElementById('modal-confirmar');
    const btnCancelar = document.getElementById('modal-cancelar');

    document.getElementById('modal-titulo').textContent = titulo;
    document.getElementById('modal-mensagem').textContent = mensagem;
    input.classList.toggle('oculto', !comInput);
    input.value = valorPadrao;
    btnConfirmar.textContent = textoConfirmar;
    btnCancelar.classList.toggle('oculto', apenasAviso);

    overlay.classList.remove('oculto');
    if (comInput) setTimeout(() => input.focus(), 30);

    function finalizar(valor) {
      overlay.classList.add('oculto');
      btnConfirmar.removeEventListener('click', onConfirmar);
      btnCancelar.removeEventListener('click', onCancelar);
      document.removeEventListener('keydown', onTecla);
      resolve(valor);
    }
    function onConfirmar() { finalizar(comInput ? (input.value.trim() || null) : true); }
    function onCancelar() { finalizar(comInput ? null : false); }
    function onTecla(e) {
      if (e.key === 'Enter') onConfirmar();
      else if (e.key === 'Escape') onCancelar();
    }

    btnConfirmar.addEventListener('click', onConfirmar);
    btnCancelar.addEventListener('click', onCancelar);
    document.addEventListener('keydown', onTecla);
  });
}

const modalPrompt = (mensagem, valorPadrao = '') =>
  abrirModal({ titulo: 'Informe um valor', mensagem, comInput: true, valorPadrao, textoConfirmar: 'Confirmar' });

const modalConfirm = (mensagem) =>
  abrirModal({ titulo: 'Confirmação', mensagem, textoConfirmar: 'Confirmar' });

const modalAlerta = (mensagem) =>
  abrirModal({ titulo: 'Aviso', mensagem, apenasAviso: true });

// ---------------------------------------------------------------------------
// Inicialização do mapa (sem camada de tiles — fundo branco puro)
// ---------------------------------------------------------------------------

const mapa = L.map('mapa', {
  center: [-14.5, -52],
  zoom: 4,
  minZoom: 3,
  maxZoom: 12,
  zoomControl: true,
  attributionControl: false,
  preferCanvas: true,
  boxZoom: false, // Shift+arrastar é usado para "pintar" a seleção de municípios, não para zoom
});

// Renderer canvas único e compartilhado por todas as camadas vetoriais.
// Isso garante boa performance com milhares de polígonos e permite
// exportar a imagem final combinando um único elemento <canvas>.
const rendererCompartilhado = L.canvas({ padding: 0.4 });

// Recalcula o tamanho do mapa quando a janela é redimensionada (evita
// dessincronização entre a posição do mouse e as coordenadas do mapa)
window.addEventListener('resize', () => mapa.invalidateSize());

const camadaEstados = L.layerGroup();
const camadaMesorregioes = L.layerGroup();
const camadaMunicipios = L.layerGroup();
const camadaRotulosEstados = L.layerGroup();
const camadaRotulosMesorregioes = L.layerGroup();
const camadaRotas = L.layerGroup().addTo(mapa);
const camadaMarcadores = L.layerGroup().addTo(mapa);
const camadaTextos = L.layerGroup().addTo(mapa);

// Ordem de adição = ordem de desenho no canvas compartilhado:
// municípios (preenchimento) -> mesorregiões (tracejado) -> estados (contorno forte)
camadaMunicipios.addTo(mapa);
camadaMesorregioes.addTo(mapa);
camadaEstados.addTo(mapa);
camadaRotulosEstados.addTo(mapa);
camadaRotulosMesorregioes.addTo(mapa);

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function normalizarTexto(txt) {
  return (txt || '')
    .toString()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function corDoMunicipio(codigo) {
  if (coresIndividuais.has(codigo)) return coresIndividuais.get(codigo);
  const idGrupo = municipioParaGrupo.get(codigo);
  if (idGrupo) {
    const g = grupos.find((gr) => gr.id === idGrupo);
    if (g) return g.cor;
  }
  return null;
}

// Município/mesorregião pertence a um estado diferente do filtrado atualmente
function foraDoFiltro(feature) {
  return !!estadoFiltroAtual && feature.properties.uf_codigo !== estadoFiltroAtual;
}

// O próprio estado (UF) não é o estado filtrado atualmente
function estadoForaDoFiltro(feature) {
  return !!estadoFiltroAtual && feature.properties.codigo !== estadoFiltroAtual;
}

function estiloMunicipio(feature) {
  const codigo = feature.properties.codigo;
  const cor = corDoMunicipio(codigo);
  const selecionado = selecionados.has(codigo);
  const oculto = foraDoFiltro(feature);
  const chkMun = document.getElementById('chk-municipios');
  const exibirContornoMunicipios = chkMun ? chkMun.checked : true;

  if (oculto) {
    return {
      renderer: rendererCompartilhado,
      stroke: false,
      fill: false,
      fillOpacity: 0,
      opacity: 0,
      weight: 0,
    };
  }

  // Se o contorno de municípios estiver desativado, apenas municípios sem cor e não selecionados
  // ficam transparentes; os municípios com cor continuam 100% visíveis com seu preenchimento sem linhas!
  const temCor = !!cor;
  const visivel = exibirContornoMunicipios || temCor || selecionado;

  if (!visivel) {
    return {
      renderer: rendererCompartilhado,
      stroke: false,
      fill: false,
      fillOpacity: 0,
      opacity: 0,
      weight: 0,
    };
  }

  const desenharBorda = selecionado || exibirContornoMunicipios;

  return {
    renderer: rendererCompartilhado,
    stroke: desenharBorda,
    color: selecionado
      ? CORES.municipioContornoSelecionado
      : CORES.municipioContorno,
    weight: selecionado ? 2.5 : (exibirContornoMunicipios ? 0.8 : 0),
    dashArray: selecionado ? '5,3' : null,
    opacity: selecionado ? 1 : (exibirContornoMunicipios ? 1 : 0),
    fill: temCor,
    fillColor: cor || '#ffffff',
    fillOpacity: temCor ? 0.72 : 0,
  };
}

function estiloEstado(feature) {
  return {
    renderer: rendererCompartilhado,
    fill: false,
    color: CORES.estadoContorno,
    weight: 1.6,
    opacity: estadoForaDoFiltro(feature) ? 0 : 1,
  };
}

function estiloMesorregiao(feature) {
  return {
    renderer: rendererCompartilhado,
    fill: false,
    color: CORES.mesorregiaoContorno,
    weight: 1.4,
    dashArray: '7,5',
    opacity: foraDoFiltro(feature) ? 0 : 0.85,
  };
}

function repintarMunicipio(codigo) {
  const item = municipiosPorCodigo.get(codigo);
  if (item) item.layer.setStyle(estiloMunicipio(item.feature));
}

function repintarTodosMunicipios() {
  municipiosPorCodigo.forEach((item) => item.layer.setStyle(estiloMunicipio(item.feature)));
}

// ---------------------------------------------------------------------------
// Carregamento dos dados oficiais do IBGE (GeoJSON)
// ---------------------------------------------------------------------------

async function carregarCamadas() {
  const [geoEstados, geoMesorregioes, geoMunicipios] = await Promise.all([
    fetch('data/estados.geojson').then((r) => r.json()),
    fetch('data/mesorregioes.geojson').then((r) => r.json()),
    fetch('data/municipios.geojson').then((r) => r.json()),
  ]);

  // --- Municípios (camada de baixo, recebe seleção/coloração) -------------
  L.geoJSON(geoMunicipios, {
    renderer: rendererCompartilhado,
    style: estiloMunicipio,
    onEachFeature: (feature, layer) => {
      const p = feature.properties;
      municipiosPorCodigo.set(p.codigo, {
        feature,
        layer,
        nome: p.nome,
        uf_sigla: p.uf_sigla,
        meso_codigo: p.meso_codigo,
        meso_nome: p.meso_nome,
      });

      if (p.meso_codigo) {
        if (!municipiosPorMesorregiao.has(p.meso_codigo)) {
          municipiosPorMesorregiao.set(p.meso_codigo, new Set());
        }
        municipiosPorMesorregiao.get(p.meso_codigo).add(p.codigo);

        if (!mesorregioesInfo.has(p.meso_codigo)) {
          mesorregioesInfo.set(p.meso_codigo, {
            codigo: p.meso_codigo,
            nome: p.meso_nome,
            uf_codigo: p.uf_codigo,
            uf_sigla: p.uf_sigla,
          });
        }
      }

      layer.bindTooltip(`${p.nome} — ${p.uf_sigla}`, {
        sticky: true,
        className: 'tooltip-municipio',
      });

      layer.on('click', (e) => {
        if (foraDoFiltro(feature)) return; // fora do estado filtrado: ignora o clique
        L.DomEvent.stopPropagation(e);

        // Modo Conta-Gotas (Pipeta)
        if (modoAtual === 'pipeta') {
          const cor = corDoMunicipio(p.codigo);
          if (cor) {
            document.getElementById('cor-individual').value = cor;
            if (window.AppColaboracao?.mostrarToast) {
              window.AppColaboracao.mostrarToast(`Cor ${cor} copiada de ${p.nome}!`);
            }
          } else {
            if (window.AppColaboracao?.mostrarToast) {
              window.AppColaboracao.mostrarToast(`${p.nome} não tem cor atribuída.`);
            }
          }
          definirModo('selecionar');
          return;
        }

        // Modo Mesorregião (botão no topo ativo ou segurando a tecla Alt)
        if (modoAtual === 'mesorregiao' || (e.originalEvent && e.originalEvent.altKey)) {
          if (p.meso_codigo) {
            const acumular = multiSelecaoAtiva || (e.originalEvent && e.originalEvent.shiftKey);
            selecionarMesorregiao(p.meso_codigo, acumular);
            const selectMeso = document.getElementById('select-mesorregiao');
            if (selectMeso) selectMeso.value = p.meso_codigo;
          }
          return;
        }

        // Modo Seleção Comum
        if (modoAtual === 'selecionar') {
          if (e.originalEvent && e.originalEvent.shiftKey) {
            selecionados.add(p.codigo);
            repintarMunicipio(p.codigo);
            atualizarPainelSelecao();
          } else {
            alternarSelecaoMunicipio(p.codigo);
          }
          if (p.meso_codigo) {
            const selectMeso = document.getElementById('select-mesorregiao');
            if (selectMeso) selectMeso.value = p.meso_codigo;
          }
        }
      });

      layer.on('mouseover', () => {
        if (foraDoFiltro(feature)) { layer.closeTooltip(); return; }
        const chkMun = document.getElementById('chk-municipios');
        const exibirContornoMunicipios = chkMun ? chkMun.checked : true;
        const temCorOuSel = corDoMunicipio(p.codigo) || selecionados.has(p.codigo);
        if (!exibirContornoMunicipios && !temCorOuSel) {
          layer.closeTooltip();
          return;
        }
        // "Pintar" a seleção: com Shift pressionado e o botão do mouse
        // apertado, cada município sob o cursor é adicionado à seleção.
        if (modoAtual === 'selecionar' && arrastandoComShiftAtivo) {
          selecionados.add(p.codigo);
          repintarMunicipio(p.codigo);
          atualizarPainelSelecao();
        }
      });
    },
  }).addTo(camadaMunicipios);

  listaBuscaMunicipios = Array.from(municipiosPorCodigo.values()).map((m) => ({
    codigo: m.feature.properties.codigo,
    nome: m.nome,
    uf_sigla: m.uf_sigla,
    normalizado: normalizarTexto(`${m.nome} ${m.uf_sigla}`),
  }));

  // --- Mesorregiões (contorno laranja tracejado, apenas visual) -----------
  camadaMesorregioesGeo = L.geoJSON(geoMesorregioes, {
    renderer: rendererCompartilhado,
    interactive: false,
    style: estiloMesorregiao,
  }).addTo(camadaMesorregioes);

  geoMesorregioes.features.forEach((f) => {
    const layerTemp = L.geoJSON(f);
    const centro = layerTemp.getBounds().getCenter();
    const marker = L.marker(centro, {
      interactive: false,
      icon: L.divIcon({ className: 'rotulo-mapa', html: f.properties.nome, iconSize: null }),
    });
    rotulosMesorregioes.push({ uf_codigo: f.properties.uf_codigo, marker });
  });

  // --- Estados (contorno preto, camada mais visível, apenas visual) -------
  camadaEstadosGeo = L.geoJSON(geoEstados, {
    renderer: rendererCompartilhado,
    interactive: false,
    style: estiloEstado,
    onEachFeature: (feature, layer) => {
      boundsPorUF.set(feature.properties.codigo, layer.getBounds());
    },
  }).addTo(camadaEstados);
  boundsBrasil = camadaEstadosGeo.getBounds();

  // Preenche o seletor "Filtrar por estado" (ordenado por nome do estado)
  const selectEstado = document.getElementById('filtro-estado');
  geoEstados.features
    .slice()
    .sort((a, b) => a.properties.nome.localeCompare(b.properties.nome, 'pt-BR'))
    .forEach((f) => {
      const opt = document.createElement('option');
      opt.value = f.properties.codigo;
      opt.textContent = `${f.properties.nome} (${f.properties.sigla})`;
      selectEstado.appendChild(opt);
    });

  geoEstados.features.forEach((f) => {
    const layerTemp = L.geoJSON(f);
    const centro = layerTemp.getBounds().getCenter();
    const marker = L.marker(centro, {
      interactive: false,
      icon: L.divIcon({ className: 'rotulo-mapa', html: `<b>${f.properties.sigla}</b>`, iconSize: null }),
    });
    rotulosEstados.push({ uf_codigo: f.properties.codigo, marker });
  });

  // Por padrão os rótulos ficam ocultos (poluem o mapa com 5.570 municípios)
  mapa.removeLayer(camadaRotulosEstados);
  mapa.removeLayer(camadaRotulosMesorregioes);
  atualizarRotulosVisiveis();

  // Preenche o seletor de mesorregiões e paleta inicial
  atualizarSelectMesorregioes();
  atualizarPaletaCoresUsadas();
}

function atualizarRotulosVisiveis() {
  camadaRotulosEstados.clearLayers();
  camadaRotulosMesorregioes.clearLayers();

  const chkRotEstados = document.getElementById('chk-rotulos-estados');
  const chkRotMeso = document.getElementById('chk-rotulos-mesorregioes');
  const exibirEstados = chkRotEstados ? chkRotEstados.checked : false;
  const exibirMeso = chkRotMeso ? chkRotMeso.checked : false;

  if (exibirEstados) {
    rotulosEstados.forEach((item) => {
      if (!estadoFiltroAtual || item.uf_codigo === estadoFiltroAtual) {
        camadaRotulosEstados.addLayer(item.marker);
      }
    });
  }

  if (exibirMeso) {
    rotulosMesorregioes.forEach((item) => {
      if (!estadoFiltroAtual || item.uf_codigo === estadoFiltroAtual) {
        camadaRotulosMesorregioes.addLayer(item.marker);
      }
    });
  }
}

function atualizarVisibilidadeItensUsuario() {
  const bounds = estadoFiltroAtual ? boundsPorUF.get(estadoFiltroAtual) : null;

  rotas.forEach((r) => {
    if (!r.layer) return;
    if (!bounds) {
      if (!camadaRotas.hasLayer(r.layer)) camadaRotas.addLayer(r.layer);
    } else {
      const dentro = (r.pontos || []).some(([lat, lng]) => bounds.contains([lat, lng]));
      if (dentro && !camadaRotas.hasLayer(r.layer)) camadaRotas.addLayer(r.layer);
      else if (!dentro && camadaRotas.hasLayer(r.layer)) camadaRotas.removeLayer(r.layer);
    }
  });

  marcadores.forEach((m) => {
    if (!m.layer) return;
    if (!bounds) {
      if (!camadaMarcadores.hasLayer(m.layer)) camadaMarcadores.addLayer(m.layer);
    } else {
      const dentro = bounds.contains([m.lat, m.lng]);
      if (dentro && !camadaMarcadores.hasLayer(m.layer)) camadaMarcadores.addLayer(m.layer);
      else if (!dentro && camadaMarcadores.hasLayer(m.layer)) camadaMarcadores.removeLayer(m.layer);
    }
  });

  textos.forEach((t) => {
    if (!t.layer) return;
    if (!bounds) {
      if (!camadaTextos.hasLayer(t.layer)) camadaTextos.addLayer(t.layer);
    } else {
      const dentro = bounds.contains([t.lat, t.lng]);
      if (dentro && !camadaTextos.hasLayer(t.layer)) camadaTextos.addLayer(t.layer);
      else if (!dentro && camadaTextos.hasLayer(t.layer)) camadaTextos.removeLayer(t.layer);
    }
  });
}

// ---------------------------------------------------------------------------
// Seleção de municípios
// ---------------------------------------------------------------------------

function alternarSelecaoMunicipio(codigo) {
  if (multiSelecaoAtiva) {
    if (selecionados.has(codigo)) selecionados.delete(codigo);
    else selecionados.add(codigo);
    repintarMunicipio(codigo);
  } else {
    const antigos = Array.from(selecionados);
    selecionados.clear();
    selecionados.add(codigo);
    antigos.forEach((c) => repintarMunicipio(c));
    repintarMunicipio(codigo);
  }
  atualizarPainelSelecao();
}

function limparSelecao() {
  const antigos = Array.from(selecionados);
  selecionados.clear();
  antigos.forEach((c) => repintarMunicipio(c));
  atualizarPainelSelecao();
}

function atualizarPainelSelecao() {
  const el = document.getElementById('selecao-info');
  if (selecionados.size === 0) {
    el.textContent = 'Nenhum município selecionado.';
    return;
  }
  const nomes = Array.from(selecionados)
    .slice(0, 12)
    .map((cod) => {
      const m = municipiosPorCodigo.get(cod);
      return m ? `${m.nome} — ${m.uf_sigla}` : cod;
    });
  let texto = `${selecionados.size} município(s) selecionado(s):\n` + nomes.join(', ');
  if (selecionados.size > 12) texto += `, +${selecionados.size - 12}...`;
  el.textContent = texto;
}

// ---------------------------------------------------------------------------
// Cores individuais e grupos
// ---------------------------------------------------------------------------

async function aplicarCorSelecionados() {
  if (selecionados.size === 0) { await modalAlerta('Selecione ao menos um município.'); return; }
  const cor = document.getElementById('cor-individual').value;
  selecionados.forEach((cod) => {
    municipioParaGrupo.delete(cod);
    coresIndividuais.set(cod, cor);
    repintarMunicipio(cod);
  });
  salvarProjeto();
  atualizarPaletaCoresUsadas();
}

async function removerCorSelecionados() {
  if (selecionados.size === 0) { await modalAlerta('Selecione ao menos um município.'); return; }
  selecionados.forEach((cod) => {
    coresIndividuais.delete(cod);
    municipioParaGrupo.delete(cod);
    repintarMunicipio(cod);
  });
  salvarProjeto();
  atualizarPaletaCoresUsadas();
}

async function criarGrupoComSelecionados() {
  if (selecionados.size === 0) { await modalAlerta('Selecione ao menos um município para criar o grupo.'); return; }
  const nomeInput = document.getElementById('grupo-nome');
  const nome = nomeInput.value.trim() || `Grupo ${grupos.length + 1}`;
  const cor = document.getElementById('grupo-cor').value;
  const grupo = { id: proximoId(), nome, cor };
  grupos.push(grupo);
  selecionados.forEach((cod) => {
    coresIndividuais.delete(cod); // grupo tem precedência ao ser criado
    municipioParaGrupo.set(cod, grupo.id);
    repintarMunicipio(cod);
  });
  nomeInput.value = '';
  renderizarListaGrupos();
  salvarProjeto();
  atualizarPaletaCoresUsadas();
}

async function excluirGrupo(idGrupo) {
  if (!(await modalConfirm('Excluir este grupo? Os municípios voltarão a ficar sem cor.'))) return;
  grupos = grupos.filter((g) => g.id !== idGrupo);
  const afetados = [];
  municipioParaGrupo.forEach((v, k) => {
    if (v === idGrupo) {
      afetados.push(k);
      municipioParaGrupo.delete(k);
    }
  });
  renderizarListaGrupos();
  afetados.forEach((cod) => repintarMunicipio(cod));
  salvarProjeto();
  atualizarPaletaCoresUsadas();
}

// Adiciona os municípios atualmente selecionados a um grupo já existente
// (permite ir expandindo um grupo aos poucos, em vez de recriá-lo).
async function adicionarSelecionadosAoGrupo(idGrupo) {
  if (selecionados.size === 0) { await modalAlerta('Selecione ao menos um município para adicionar ao grupo.'); return; }
  selecionados.forEach((cod) => {
    coresIndividuais.delete(cod); // grupo tem precedência sobre cor individual
    municipioParaGrupo.set(cod, idGrupo);
    repintarMunicipio(cod);
  });
  renderizarListaGrupos();
  salvarProjeto();
  atualizarPaletaCoresUsadas();
}

// Remove os municípios selecionados de qualquer grupo ao qual pertençam,
// sem excluir o grupo em si.
async function removerSelecionadosDosGrupos() {
  if (selecionados.size === 0) { await modalAlerta('Selecione ao menos um município.'); return; }
  selecionados.forEach((cod) => {
    municipioParaGrupo.delete(cod);
    repintarMunicipio(cod);
  });
  renderizarListaGrupos();
  salvarProjeto();
  atualizarPaletaCoresUsadas();
}

function selecionarMunicipiosDoGrupo(idGrupo) {
  const antigos = new Set(selecionados);
  selecionados.clear();
  municipioParaGrupo.forEach((v, k) => { if (v === idGrupo) selecionados.add(k); });
  antigos.forEach((cod) => repintarMunicipio(cod));
  selecionados.forEach((cod) => repintarMunicipio(cod));
  atualizarPainelSelecao();
  ajustarVisaoParaSelecionados();
}

function ajustarVisaoParaSelecionados() {
  const bounds = [];
  selecionados.forEach((cod) => {
    const m = municipiosPorCodigo.get(cod);
    if (m && !foraDoFiltro(m.feature)) bounds.push(m.layer.getBounds());
  });
  if (bounds.length === 0) return;
  let total = bounds[0];
  bounds.forEach((b) => { total = total.extend(b); });
  mapa.fitBounds(total, { maxZoom: 9, padding: [30, 30] });
}

function renderizarListaGrupos() {
  const ul = document.getElementById('lista-grupos');
  if (!ul) return;
  ul.innerHTML = '';
  if (grupos.length === 0) {
    ul.innerHTML = '<li class="dica">Nenhum grupo criado.</li>';
    return;
  }

  const inputBusca = document.getElementById('busca-grupo');
  const termoBusca = inputBusca ? normalizarTexto(inputBusca.value.trim()) : '';

  // Filtra pelo nome se houver busca
  const gruposFiltrados = grupos.filter((g) => {
    if (!termoBusca) return true;
    return normalizarTexto(g.nome).includes(termoBusca);
  });

  if (gruposFiltrados.length === 0) {
    ul.innerHTML = `<li class="dica">Nenhum grupo encontrado com "${inputBusca.value.trim()}".</li>`;
    return;
  }

  const temFiltroEstado = !!estadoFiltroAtual;
  let nomeEstadoAtual = '';
  if (temFiltroEstado) {
    const sel = document.getElementById('filtro-estado');
    nomeEstadoAtual = sel?.options[sel.selectedIndex]?.text || 'Estado selecionado';
  }

  // Mapeia contagem de municípios totais e dentro do estado filtrado
  const gruposComContagem = gruposFiltrados.map((g) => {
    let qtdTotal = 0;
    let qtdNoEstado = 0;

    municipioParaGrupo.forEach((idGrupo, cod) => {
      if (idGrupo === g.id) {
        qtdTotal++;
        if (temFiltroEstado) {
          const m = municipiosPorCodigo.get(cod);
          if (m && m.feature.properties.uf_codigo === estadoFiltroAtual) {
            qtdNoEstado++;
          }
        }
      }
    });

    return { grupo: g, qtdTotal, qtdNoEstado };
  });

  function criarCardGrupo(item, ehNoEstado) {
    const { grupo: g, qtdTotal, qtdNoEstado } = item;
    const li = document.createElement('li');
    li.className = `card-grupo ${ehNoEstado ? 'card-grupo-no-estado' : ''}`;

    let textoContagem = `${qtdTotal} ${qtdTotal === 1 ? 'município' : 'municípios'}`;
    if (temFiltroEstado) {
      if (qtdNoEstado > 0) {
        textoContagem = `<strong class="destaque-estado">${qtdNoEstado} no estado</strong> &bull; ${qtdTotal} no total`;
      } else {
        textoContagem = `<span class="fora-estado-texto">0 no estado (${qtdTotal} em outros estados)</span>`;
      }
    }

    li.innerHTML = `
      <div class="card-grupo-topo">
        <input type="color" class="input-cor-grupo" value="${g.cor}" title="Alterar cor do grupo" />
        <div class="card-grupo-info" title="Duplo clique para renomear">
          <span class="card-grupo-nome">${g.nome}</span>
          <span class="card-grupo-contagem">${textoContagem}</span>
        </div>
      </div>
      <div class="card-grupo-acoes">
        <button type="button" class="btn-acao-grupo" data-acao="editar" title="Editar nome do grupo">✏️ Renomear</button>
        <button type="button" class="btn-acao-grupo" data-acao="adicionar" title="Adicionar municípios selecionados a este grupo">➕ Adicionar</button>
        <button type="button" class="btn-acao-grupo" data-acao="ir" title="Selecionar municípios deste grupo e focar no mapa">🎯 Focar</button>
        <button type="button" class="btn-acao-grupo btn-acao-perigo" data-acao="excluir" title="Excluir grupo">🗑️</button>
      </div>
    `;

    // Alteração de cor do grupo em tempo real (repinta apenas os municípios deste grupo)
    const inputCor = li.querySelector('.input-cor-grupo');
    const repintarMunicipiosDoGrupo = () => {
      municipioParaGrupo.forEach((idGrupo, cod) => {
        if (idGrupo === g.id) repintarMunicipio(cod);
      });
    };
    inputCor.addEventListener('input', (e) => {
      g.cor = e.target.value;
      repintarMunicipiosDoGrupo();
    });
    inputCor.addEventListener('change', (e) => {
      g.cor = e.target.value;
      repintarMunicipiosDoGrupo();
      salvarProjeto();
      atualizarPaletaCoresUsadas();
    });

    // Edição de nome do grupo
    const fnEditarNome = async () => {
      const novoNome = await modalPrompt('Editar nome do grupo:', g.nome);
      if (novoNome !== null && novoNome.trim() !== '') {
        g.nome = novoNome.trim();
        renderizarListaGrupos();
        salvarProjeto();
      }
    };
    li.querySelector('[data-acao="editar"]').onclick = fnEditarNome;
    li.querySelector('.card-grupo-info').ondblclick = fnEditarNome;

    li.querySelector('[data-acao="adicionar"]').onclick = () => adicionarSelecionadosAoGrupo(g.id);
    li.querySelector('[data-acao="ir"]').onclick = () => selecionarMunicipiosDoGrupo(g.id);
    li.querySelector('[data-acao="excluir"]').onclick = () => excluirGrupo(g.id);

    return li;
  }

  if (temFiltroEstado) {
    const noEstado = gruposComContagem.filter((item) => item.qtdNoEstado > 0);
    const foraDoEstado = gruposComContagem.filter((item) => item.qtdNoEstado === 0);

    // Seção 1: Grupos com municípios no estado filtrado
    const divisorNoEstado = document.createElement('div');
    divisorNoEstado.className = 'secao-grupos-titulo secao-grupos-estado';
    divisorNoEstado.innerHTML = `
      <span>📍 Grupos em ${nomeEstadoAtual}</span>
      <span class="secao-grupos-badge">${noEstado.length}</span>
    `;
    ul.appendChild(divisorNoEstado);

    if (noEstado.length === 0) {
      const liVazio = document.createElement('li');
      liVazio.className = 'dica';
      liVazio.style.margin = '4px 0 10px 0';
      liVazio.textContent = 'Nenhum grupo com municípios pintados neste estado.';
      ul.appendChild(liVazio);
    } else {
      noEstado.forEach((item) => ul.appendChild(criarCardGrupo(item, true)));
    }

    // Seção 2: Outros grupos (fora do estado)
    if (foraDoEstado.length > 0) {
      const divisorOutros = document.createElement('div');
      divisorOutros.className = 'secao-grupos-titulo secao-grupos-outros';
      divisorOutros.innerHTML = `
        <span>🌐 Outros Grupos (fora deste estado)</span>
        <span class="secao-grupos-badge">${foraDoEstado.length}</span>
      `;
      ul.appendChild(divisorOutros);

      foraDoEstado.forEach((item) => ul.appendChild(criarCardGrupo(item, false)));
    }
  } else {
    // Sem filtro de estado: exibe todos normalmente
    gruposComContagem.forEach((item) => ul.appendChild(criarCardGrupo(item, false)));
  }
}

// ---------------------------------------------------------------------------
// Ações Rápidas por Mesorregião
// ---------------------------------------------------------------------------

function atualizarSelectMesorregioes() {
  const select = document.getElementById('select-mesorregiao');
  if (!select) return;
  const valorAnterior = select.value;
  select.innerHTML = '<option value="">Escolha uma mesorregião...</option>';

  const lista = Array.from(mesorregioesInfo.values())
    .filter((m) => !estadoFiltroAtual || m.uf_codigo === estadoFiltroAtual)
    .sort((a, b) => {
      if (a.uf_sigla !== b.uf_sigla) return a.uf_sigla.localeCompare(b.uf_sigla);
      return a.nome.localeCompare(b.nome, 'pt-BR');
    });

  lista.forEach((info) => {
    const qtd = municipiosPorMesorregiao.get(info.codigo)?.size || 0;
    const opt = document.createElement('option');
    opt.value = info.codigo;
    opt.textContent = `${info.nome} — ${info.uf_sigla} (${qtd} mun.)`;
    select.appendChild(opt);
  });

  if (valorAnterior && mesorregioesInfo.has(valorAnterior)) {
    select.value = valorAnterior;
  }
}

function selecionarMesorregiao(mesoCodigo, acumular = false) {
  const codigos = municipiosPorMesorregiao.get(mesoCodigo);
  if (!codigos) return;
  const antigos = acumular ? new Set() : new Set(selecionados);
  if (!acumular) {
    selecionados.clear();
  }
  const novos = [];
  codigos.forEach((cod) => {
    const m = municipiosPorCodigo.get(cod);
    if (m && !foraDoFiltro(m.feature)) {
      selecionados.add(cod);
      novos.push(cod);
    }
  });
  antigos.forEach((cod) => repintarMunicipio(cod));
  novos.forEach((cod) => repintarMunicipio(cod));
  atualizarPainelSelecao();
  ajustarVisaoParaSelecionados();
}

function pintarMesorregiao(mesoCodigo, cor) {
  const codigos = municipiosPorMesorregiao.get(mesoCodigo);
  if (!codigos) return;
  codigos.forEach((cod) => {
    municipioParaGrupo.delete(cod);
    coresIndividuais.set(cod, cor);
    repintarMunicipio(cod);
  });
  salvarProjeto();
  atualizarPaletaCoresUsadas();
}

// ---------------------------------------------------------------------------
// Pipeta (Conta-gotas) e Seleção por Cores Iguais
// ---------------------------------------------------------------------------

function coletarCoresEmUso() {
  const contagem = new Map();
  municipiosPorCodigo.forEach((item, cod) => {
    const cor = corDoMunicipio(cod);
    if (cor) {
      const corNorm = cor.toLowerCase();
      contagem.set(corNorm, (contagem.get(corNorm) || 0) + 1);
    }
  });
  return contagem;
}

function atualizarPaletaCoresUsadas() {
  const container = document.getElementById('paleta-cores-usadas');
  if (!container) return;
  const cores = coletarCoresEmUso();

  container.innerHTML = '';
  if (cores.size === 0) {
    container.innerHTML = '<span class="dica" style="margin:0;">Nenhuma cor em uso no mapa.</span>';
    return;
  }

  cores.forEach((qtd, cor) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swatch-item';
    btn.title = `Cor ${cor} (${qtd} municípios)\nClique: Definir como cor no seletor\nShift+Clique ou Duplo clique: Selecionar municípios com esta cor`;
    btn.innerHTML = `
      <span class="swatch-cor-bolinha" style="background:${cor}"></span>
      <span>${cor}</span>
      <span class="swatch-qtd">(${qtd})</span>
    `;

    btn.addEventListener('click', (e) => {
      if (e.shiftKey) {
        selecionarMunicipiosComMesmaCor(cor);
      } else {
        document.getElementById('cor-individual').value = cor;
        if (window.AppColaboracao?.mostrarToast) {
          window.AppColaboracao.mostrarToast(`Cor ${cor} pronta no seletor!`);
        }
      }
    });

    btn.addEventListener('dblclick', () => {
      selecionarMunicipiosComMesmaCor(cor);
    });

    container.appendChild(btn);
  });
}

function copiarCorDoSelecionado() {
  if (selecionados.size === 0) {
    modalAlerta('Selecione ao menos um município no mapa para copiar a cor dele.');
    return;
  }
  const primeiroCod = selecionados.values().next().value;
  const cor = corDoMunicipio(primeiroCod);
  if (cor) {
    document.getElementById('cor-individual').value = cor;
    const m = municipiosPorCodigo.get(primeiroCod);
    if (window.AppColaboracao?.mostrarToast) {
      window.AppColaboracao.mostrarToast(`Cor ${cor} copiada de ${m ? m.nome : primeiroCod}!`);
    }
  } else {
    modalAlerta('O município selecionado não possui cor aplicada.');
  }
}

function selecionarMunicipiosComMesmaCor(corAlvo) {
  if (!corAlvo) {
    if (selecionados.size > 0) {
      const primeiroCod = selecionados.values().next().value;
      corAlvo = corDoMunicipio(primeiroCod) || document.getElementById('cor-individual').value;
    } else {
      corAlvo = document.getElementById('cor-individual').value;
    }
  }

  if (!corAlvo) return;
  corAlvo = corAlvo.toLowerCase();

  const antigos = new Set(selecionados);
  selecionados.clear();
  let count = 0;
  municipiosPorCodigo.forEach((item, cod) => {
    if (foraDoFiltro(item.feature)) return;
    const cor = corDoMunicipio(cod);
    if (cor && cor.toLowerCase() === corAlvo) {
      selecionados.add(cod);
      count++;
    }
  });

  if (count === 0) {
    if (window.AppColaboracao?.mostrarToast) {
      window.AppColaboracao.mostrarToast(`Nenhum município encontrado com a cor ${corAlvo}.`);
    } else {
      modalAlerta(`Nenhum município encontrado com a cor ${corAlvo}.`);
    }
    return;
  }

  antigos.forEach((cod) => repintarMunicipio(cod));
  selecionados.forEach((cod) => repintarMunicipio(cod));
  atualizarPainelSelecao();
  ajustarVisaoParaSelecionados();

  if (window.AppColaboracao?.mostrarToast) {
    window.AppColaboracao.mostrarToast(`${count} município(s) selecionado(s) com a cor ${corAlvo}!`);
  }
}

// ---------------------------------------------------------------------------
// Modos de interação (barra de ferramentas)
// ---------------------------------------------------------------------------

function definirModo(novoModo) {
  // Ao trocar de modo, descarta um desenho de rota em andamento.
  if (modoAtual === 'rota' && novoModo !== 'rota') cancelarRotaEmAndamento();

  modoAtual = novoModo;

  const containerMapa = mapa.getContainer();
  if (containerMapa) {
    containerMapa.classList.toggle('cursor-pipeta', novoModo === 'pipeta');
  }

  document.querySelectorAll('.tool-btn[data-modo]').forEach((btn) => btn.classList.remove('ativo'));
  const botaoAtivo = document.querySelector(`.tool-btn[data-modo="${novoModo}"]`);
  if (botaoAtivo) botaoAtivo.classList.add('ativo');

  const indicador = document.getElementById('modo-indicador');
  const nomesModo = {
    selecionar: 'Selecionar município(s)',
    mesorregiao: 'Mesorregião — clique para selecionar a mesorregião inteira',
    pipeta: 'Conta-gotas — clique em um município para copiar sua cor',
    rota: 'Desenhando rota — clique para adicionar pontos',
    marcador: 'Clique no mapa para adicionar um marcador',
    texto: 'Clique no mapa para inserir um texto',
  };
  document.getElementById('modo-texto').textContent = nomesModo[novoModo] || novoModo;
  indicador.classList.remove('oculto');

  document.getElementById('btn-finalizar').classList.toggle('oculto', novoModo !== 'rota');
}

function cancelarRotaEmAndamento() {
  pontosRotaAtual = [];
  if (linhaRotaTemp) { camadaRotas.removeLayer(linhaRotaTemp); linhaRotaTemp = null; }
}

// Clique genérico no mapa: usado pelos modos rota / marcador / texto.
mapa.on('click', (e) => {
  if (modoAtual === 'rota') adicionarPontoRota(e.latlng);
  else if (modoAtual === 'marcador') criarMarcadorInterativo(e.latlng);
  else if (modoAtual === 'texto') criarTextoInterativo(e.latlng);
});

// ---------------------------------------------------------------------------
// Rotas (linhas desenhadas sobre o mapa)
// ---------------------------------------------------------------------------

function adicionarPontoRota(latlng) {
  pontosRotaAtual.push([latlng.lat, latlng.lng]);
  if (linhaRotaTemp) camadaRotas.removeLayer(linhaRotaTemp);
  linhaRotaTemp = L.polyline(pontosRotaAtual, {
    renderer: rendererCompartilhado,
    color: '#2f6fed',
    weight: 3,
    dashArray: '2,6',
  }).addTo(camadaRotas);
}

async function finalizarRota() {
  if (pontosRotaAtual.length < 2) {
    await modalAlerta('Adicione pelo menos 2 pontos clicando no mapa antes de finalizar a rota.');
    return;
  }
  const nome = await modalPrompt('Nome da rota:', `Rota ${rotas.length + 1}`);
  if (nome === null) { cancelarRotaEmAndamento(); return; }
  const cor = document.getElementById('cor-individual').value || '#2f6fed';

  if (linhaRotaTemp) camadaRotas.removeLayer(linhaRotaTemp);
  const layer = L.polyline(pontosRotaAtual, { renderer: rendererCompartilhado, color: cor, weight: 3 })
    .addTo(camadaRotas)
    .bindTooltip(nome, { sticky: true });

  rotas.push({ id: proximoId(), nome: nome || 'Rota', cor, pontos: pontosRotaAtual, layer });
  pontosRotaAtual = [];
  linhaRotaTemp = null;
  renderizarListaRotas();
  salvarProjeto();
}

async function excluirRota(id) {
  const rota = rotas.find((r) => r.id === id);
  if (!rota) return;
  if (!(await modalConfirm(`Excluir a rota "${rota.nome}"?`))) return;
  camadaRotas.removeLayer(rota.layer);
  rotas = rotas.filter((r) => r.id !== id);
  renderizarListaRotas();
  salvarProjeto();
}

function renderizarListaRotas() {
  const ul = document.getElementById('lista-rotas');
  ul.innerHTML = '';
  if (rotas.length === 0) { ul.innerHTML = '<li class="dica">Nenhuma rota criada.</li>'; return; }
  rotas.forEach((r) => {
    const li = document.createElement('li');
    li.className = 'item-lista';
    li.innerHTML = `
      <span class="amostra-cor" style="background:${r.cor}"></span>
      <span class="item-nome" title="${r.nome}">${r.nome}</span>
      <button data-acao="ir" title="Centralizar">🎯</button>
      <button data-acao="excluir" title="Excluir">🗑️</button>
    `;
    li.querySelector('[data-acao="ir"]').onclick = () => mapa.fitBounds(r.layer.getBounds(), { padding: [30, 30] });
    li.querySelector('[data-acao="excluir"]').onclick = () => excluirRota(r.id);
    ul.appendChild(li);
  });
}

// ---------------------------------------------------------------------------
// Marcadores
// ---------------------------------------------------------------------------

function iconeMarcador() {
  return L.divIcon({ className: 'icone-marcador', iconSize: [22, 22], iconAnchor: [11, 22] });
}

async function criarMarcadorInterativo(latlng) {
  const titulo = await modalPrompt('Título do marcador:');
  if (titulo === null) return;
  const texto = (await modalPrompt('Observação (opcional):')) || '';
  adicionarMarcador({ id: proximoId(), lat: latlng.lat, lng: latlng.lng, titulo: titulo || 'Marcador', texto });
  salvarProjeto();
}

function adicionarMarcador(dados) {
  const layer = L.marker([dados.lat, dados.lng], { icon: iconeMarcador(), draggable: true })
    .addTo(camadaMarcadores)
    .bindPopup(`<b>${dados.titulo}</b>${dados.texto ? '<br>' + dados.texto : ''}`);

  layer.on('dragend', () => {
    const p = layer.getLatLng();
    dados.lat = p.lat; dados.lng = p.lng;
    salvarProjeto();
  });
  layer.on('dblclick', () => editarMarcador(dados.id));

  dados.layer = layer;
  marcadores.push(dados);
  renderizarListaMarcadores();
}

async function editarMarcador(id) {
  const m = marcadores.find((x) => x.id === id);
  if (!m) return;
  const novoTitulo = await modalPrompt('Editar título:', m.titulo);
  if (novoTitulo === null) return;
  const novoTexto = await modalPrompt('Editar observação:', m.texto);
  m.titulo = novoTitulo || m.titulo;
  m.texto = novoTexto === null ? m.texto : novoTexto;
  m.layer.setPopupContent(`<b>${m.titulo}</b>${m.texto ? '<br>' + m.texto : ''}`);
  renderizarListaMarcadores();
  salvarProjeto();
}

async function excluirMarcador(id) {
  const m = marcadores.find((x) => x.id === id);
  if (!m) return;
  if (!(await modalConfirm(`Excluir o marcador "${m.titulo}"?`))) return;
  camadaMarcadores.removeLayer(m.layer);
  marcadores = marcadores.filter((x) => x.id !== id);
  renderizarListaMarcadores();
  salvarProjeto();
}

function renderizarListaMarcadores() {
  const ul = document.getElementById('lista-marcadores');
  ul.innerHTML = '';
  if (marcadores.length === 0) { ul.innerHTML = '<li class="dica">Nenhum marcador criado.</li>'; return; }
  marcadores.forEach((m) => {
    const li = document.createElement('li');
    li.className = 'item-lista';
    li.innerHTML = `
      <span class="amostra-cor" style="background:#e14b4b"></span>
      <span class="item-nome" title="${m.titulo}">${m.titulo}</span>
      <button data-acao="ir" title="Centralizar">🎯</button>
      <button data-acao="editar" title="Editar">✏️</button>
      <button data-acao="excluir" title="Excluir">🗑️</button>
    `;
    li.querySelector('[data-acao="ir"]').onclick = () => mapa.setView([m.lat, m.lng], 10);
    li.querySelector('[data-acao="editar"]').onclick = () => editarMarcador(m.id);
    li.querySelector('[data-acao="excluir"]').onclick = () => excluirMarcador(m.id);
    ul.appendChild(li);
  });
}

// ---------------------------------------------------------------------------
// Textos / observações livres no mapa
// ---------------------------------------------------------------------------

async function criarTextoInterativo(latlng) {
  const texto = await modalPrompt('Digite o texto/observação:');
  if (!texto) return;
  adicionarTexto({ id: proximoId(), lat: latlng.lat, lng: latlng.lng, texto });
  salvarProjeto();
}

function adicionarTexto(dados) {
  const icon = L.divIcon({ className: 'icone-texto', html: dados.texto, iconSize: null });
  const layer = L.marker([dados.lat, dados.lng], { icon, draggable: true }).addTo(camadaTextos);

  layer.on('dragend', () => {
    const p = layer.getLatLng();
    dados.lat = p.lat; dados.lng = p.lng;
    salvarProjeto();
  });
  layer.on('dblclick', () => editarTexto(dados.id));

  dados.layer = layer;
  textos.push(dados);
  renderizarListaTextos();
}

async function editarTexto(id) {
  const t = textos.find((x) => x.id === id);
  if (!t) return;
  const novoTexto = await modalPrompt('Editar texto:', t.texto);
  if (!novoTexto) return;
  t.texto = novoTexto;
  t.layer.setIcon(L.divIcon({ className: 'icone-texto', html: novoTexto, iconSize: null }));
  renderizarListaTextos();
  salvarProjeto();
}

async function excluirTexto(id) {
  const t = textos.find((x) => x.id === id);
  if (!t) return;
  if (!(await modalConfirm('Excluir este texto?'))) return;
  camadaTextos.removeLayer(t.layer);
  textos = textos.filter((x) => x.id !== id);
  renderizarListaTextos();
  salvarProjeto();
}

function renderizarListaTextos() {
  const ul = document.getElementById('lista-textos');
  ul.innerHTML = '';
  if (textos.length === 0) { ul.innerHTML = '<li class="dica">Nenhum texto criado.</li>'; return; }
  textos.forEach((t) => {
    const li = document.createElement('li');
    li.className = 'item-lista';
    li.innerHTML = `
      <span class="item-nome" title="${t.texto}">${t.texto}</span>
      <button data-acao="ir" title="Centralizar">🎯</button>
      <button data-acao="editar" title="Editar">✏️</button>
      <button data-acao="excluir" title="Excluir">🗑️</button>
    `;
    li.querySelector('[data-acao="ir"]').onclick = () => mapa.setView([t.lat, t.lng], 10);
    li.querySelector('[data-acao="editar"]').onclick = () => editarTexto(t.id);
    li.querySelector('[data-acao="excluir"]').onclick = () => excluirTexto(t.id);
    ul.appendChild(li);
  });
}

// ---------------------------------------------------------------------------
// Busca de municípios
// ---------------------------------------------------------------------------

const buscaInput = document.getElementById('busca-input');
const buscaResultados = document.getElementById('busca-resultados');

buscaInput.addEventListener('input', () => {
  const termo = normalizarTexto(buscaInput.value.trim());
  if (termo.length < 2) { buscaResultados.classList.add('oculto'); buscaResultados.innerHTML = ''; return; }
  const resultados = listaBuscaMunicipios.filter((m) => m.normalizado.includes(termo)).slice(0, 20);
  if (resultados.length === 0) {
    buscaResultados.innerHTML = '<div class="dica" style="padding:8px;">Nenhum município encontrado.</div>';
  } else {
    buscaResultados.innerHTML = resultados
      .map((m) => `<div data-codigo="${m.codigo}">${m.nome} — ${m.uf_sigla}</div>`)
      .join('');
    buscaResultados.querySelectorAll('div[data-codigo]').forEach((div) => {
      div.addEventListener('click', () => {
        const cod = div.getAttribute('data-codigo');
        irParaMunicipio(cod);
        buscaResultados.classList.add('oculto');
        buscaInput.value = '';
      });
    });
  }
  buscaResultados.classList.remove('oculto');
});

function irParaMunicipio(codigo) {
  const m = municipiosPorCodigo.get(codigo);
  if (!m) return;
  mapa.fitBounds(m.layer.getBounds(), { maxZoom: 10, padding: [40, 40] });
  const antigos = Array.from(selecionados);
  selecionados.clear();
  selecionados.add(codigo);
  antigos.forEach((c) => repintarMunicipio(c));
  repintarMunicipio(codigo);
  atualizarPainelSelecao();
}

// ---------------------------------------------------------------------------
// Persistência (localStorage) e Exportar/Importar JSON
// ---------------------------------------------------------------------------

function estadoParaObjeto() {
  return {
    versao: 1,
    dataExportacao: new Date().toISOString(),
    coresIndividuais: Object.fromEntries(coresIndividuais),
    municipioParaGrupo: Object.fromEntries(municipioParaGrupo),
    grupos: grupos.map((g) => ({ id: g.id, nome: g.nome, cor: g.cor })),
    rotas: rotas.map((r) => ({ id: r.id, nome: r.nome, cor: r.cor, pontos: r.pontos })),
    marcadores: marcadores.map((m) => ({ id: m.id, lat: m.lat, lng: m.lng, titulo: m.titulo, texto: m.texto })),
    textos: textos.map((t) => ({ id: t.id, lat: t.lat, lng: t.lng, texto: t.texto })),
    camadas: {
      estados: document.getElementById('chk-estados').checked,
      mesorregioes: document.getElementById('chk-mesorregioes').checked,
      municipios: document.getElementById('chk-municipios').checked,
      rotulosEstados: document.getElementById('chk-rotulos-estados').checked,
      rotulosMesorregioes: document.getElementById('chk-rotulos-mesorregioes').checked,
    },
  };
}

function salvarProjeto() {
  try {
    localStorage.setItem(CHAVE_LOCALSTORAGE, JSON.stringify(estadoParaObjeto()));
  } catch (erro) {
    console.warn('Não foi possível salvar o projeto no localStorage:', erro);
  }
  if (window.AppColaboracao && typeof window.AppColaboracao.salvarRemoto === 'function') {
    window.AppColaboracao.salvarRemoto();
  }
}

function limparCamadasDinamicas(limparSelecao = false) {
  rotas.forEach((r) => camadaRotas.removeLayer(r.layer));
  marcadores.forEach((m) => camadaMarcadores.removeLayer(m.layer));
  textos.forEach((t) => camadaTextos.removeLayer(t.layer));
  rotas = []; marcadores = []; textos = [];
  coresIndividuais.clear();
  municipioParaGrupo.clear();
  grupos = [];
  if (limparSelecao) {
    selecionados.clear();
  }
}

function aplicarEstadoDoObjeto(obj, { limparSelecao = false } = {}) {
  limparCamadasDinamicas(limparSelecao);

  coresIndividuais = new Map(Object.entries(obj.coresIndividuais || {}));
  municipioParaGrupo = new Map(Object.entries(obj.municipioParaGrupo || {}));
  grupos = Array.isArray(obj.grupos) ? obj.grupos : [];

  (obj.rotas || []).forEach((r) => {
    const layer = L.polyline(r.pontos, { renderer: rendererCompartilhado, color: r.cor, weight: 3 })
      .addTo(camadaRotas)
      .bindTooltip(r.nome, { sticky: true });
    rotas.push({ ...r, layer });
  });

  (obj.marcadores || []).forEach((m) => adicionarMarcador({ ...m }));
  (obj.textos || []).forEach((t) => adicionarTexto({ ...t }));

  if (obj.camadas) {
    document.getElementById('chk-estados').checked = obj.camadas.estados !== false;
    document.getElementById('chk-mesorregioes').checked = obj.camadas.mesorregioes !== false;
    document.getElementById('chk-municipios').checked = obj.camadas.municipios !== false;
    document.getElementById('chk-rotulos-estados').checked = !!obj.camadas.rotulosEstados;
    document.getElementById('chk-rotulos-mesorregioes').checked = !!obj.camadas.rotulosMesorregioes;
    aplicarVisibilidadeCamadas();
  }

  renderizarListaGrupos();
  renderizarListaRotas();
  renderizarListaMarcadores();
  renderizarListaTextos();
  repintarTodosMunicipios();
  atualizarPainelSelecao();
  atualizarPaletaCoresUsadas();
}

// ---------------------------------------------------------------------------
// Sincronização Remota Não-Destrutiva (Colaboração em Tempo Real)
// Atualiza cores, grupos, rotas, marcadores e textos vindos da nuvem
// SEM interferir na seleção local, rotas em andamento ou camadas do usuário.
// ---------------------------------------------------------------------------
function aplicarEstadoRemoto(remoto) {
  if (!remoto) return;

  const paraRepintar = new Set();
  const novoCoresIndividuais = new Map(Object.entries(remoto.coresIndividuais || {}));
  const novoMunicipioParaGrupo = new Map(Object.entries(remoto.municipioParaGrupo || {}));
  const novosGrupos = Array.isArray(remoto.grupos) ? remoto.grupos : [];

  // Compara cores individuais
  coresIndividuais.forEach((cor, cod) => {
    if (novoCoresIndividuais.get(cod) !== cor) paraRepintar.add(cod);
  });
  novoCoresIndividuais.forEach((cor, cod) => {
    if (coresIndividuais.get(cod) !== cor) paraRepintar.add(cod);
  });

  // Compara associação a grupos
  municipioParaGrupo.forEach((gid, cod) => {
    if (novoMunicipioParaGrupo.get(cod) !== gid) paraRepintar.add(cod);
  });
  novoMunicipioParaGrupo.forEach((gid, cod) => {
    if (municipioParaGrupo.get(cod) !== gid) paraRepintar.add(cod);
  });

  // Compara cor dos grupos
  grupos.forEach((g) => {
    const ng = novosGrupos.find((item) => item.id === g.id);
    if (ng && ng.cor !== g.cor) {
      municipioParaGrupo.forEach((gid, cod) => {
        if (gid === g.id) paraRepintar.add(cod);
      });
      novoMunicipioParaGrupo.forEach((gid, cod) => {
        if (gid === g.id) paraRepintar.add(cod);
      });
    }
  });

  // 1. Atualiza cores individuais
  coresIndividuais = novoCoresIndividuais;

  // 2. Atualiza municípios pertencentes a grupos
  municipioParaGrupo = novoMunicipioParaGrupo;

  // 3. Atualiza grupos
  grupos = novosGrupos;

  // 4. Sincronização inteligente de rotas (preserva linhaRotaTemp da rota em andamento do usuário)
  const rotasRemotas = Array.isArray(remoto.rotas) ? remoto.rotas : [];
  const idsRotasRemotas = new Set(rotasRemotas.map((r) => r.id));

  rotas = rotas.filter((r) => {
    if (!idsRotasRemotas.has(r.id)) {
      if (r.layer) camadaRotas.removeLayer(r.layer);
      return false;
    }
    return true;
  });

  rotasRemotas.forEach((rRemota) => {
    const rotaExistente = rotas.find((r) => r.id === rRemota.id);
    if (!rotaExistente) {
      const layer = L.polyline(rRemota.pontos, { renderer: rendererCompartilhado, color: rRemota.cor, weight: 3 })
        .addTo(camadaRotas)
        .bindTooltip(rRemota.nome, { sticky: true });
      rotas.push({ ...rRemota, layer });
    } else {
      if (rotaExistente.cor !== rRemota.cor && rotaExistente.layer) {
        rotaExistente.layer.setStyle({ color: rRemota.cor });
        rotaExistente.cor = rRemota.cor;
      }
      if (rotaExistente.nome !== rRemota.nome && rotaExistente.layer) {
        rotaExistente.layer.setTooltipContent(rRemota.nome);
        rotaExistente.nome = rRemota.nome;
      }
    }
  });

  // 5. Sincronização inteligente de marcadores (não fecha popups ativos desnecessariamente)
  const marcadoresRemotos = Array.isArray(remoto.marcadores) ? remoto.marcadores : [];
  const idsMarcadoresRemotos = new Set(marcadoresRemotos.map((m) => m.id));

  marcadores = marcadores.filter((m) => {
    if (!idsMarcadoresRemotos.has(m.id)) {
      if (m.layer) camadaMarcadores.removeLayer(m.layer);
      return false;
    }
    return true;
  });

  marcadoresRemotos.forEach((mRemoto) => {
    const mExistente = marcadores.find((m) => m.id === mRemoto.id);
    if (!mExistente) {
      adicionarMarcador({ ...mRemoto });
    } else {
      if (mExistente.lat !== mRemoto.lat || mExistente.lng !== mRemoto.lng) {
        mExistente.lat = mRemoto.lat;
        mExistente.lng = mRemoto.lng;
        if (mExistente.layer) mExistente.layer.setLatLng([mRemoto.lat, mRemoto.lng]);
      }
      if (mExistente.titulo !== mRemoto.titulo || mExistente.texto !== mRemoto.texto) {
        mExistente.titulo = mRemoto.titulo;
        mExistente.texto = mRemoto.texto;
        if (mExistente.layer) {
          mExistente.layer.setPopupContent(`<b>${mRemoto.titulo}</b>${mRemoto.texto ? '<br>' + mRemoto.texto : ''}`);
        }
      }
    }
  });

  // 6. Sincronização inteligente de textos
  const textosRemotos = Array.isArray(remoto.textos) ? remoto.textos : [];
  const idsTextosRemotos = new Set(textosRemotos.map((t) => t.id));

  textos = textos.filter((t) => {
    if (!idsTextosRemotos.has(t.id)) {
      if (t.layer) camadaTextos.removeLayer(t.layer);
      return false;
    }
    return true;
  });

  textosRemotos.forEach((tRemoto) => {
    const tExistente = textos.find((t) => t.id === tRemoto.id);
    if (!tExistente) {
      adicionarTexto({ ...tRemoto });
    } else {
      if (tExistente.lat !== tRemoto.lat || tExistente.lng !== tRemoto.lng) {
        tExistente.lat = tRemoto.lat;
        tExistente.lng = tRemoto.lng;
        if (tExistente.layer) tExistente.layer.setLatLng([tRemoto.lat, tRemoto.lng]);
      }
      if (tExistente.texto !== tRemoto.texto) {
        tExistente.texto = tRemoto.texto;
        if (tExistente.layer) {
          tExistente.layer.setIcon(L.divIcon({ className: 'icone-texto', html: tRemoto.texto, iconSize: null }));
        }
      }
    }
  });

  // 7. Atualiza visibilidade de itens conforme filtro de estado
  atualizarVisibilidadeItensUsuario();

  // 8. Atualiza listas do painel lateral
  renderizarListaGrupos();
  renderizarListaRotas();
  renderizarListaMarcadores();
  renderizarListaTextos();

  // 9. Repinta apenas os municípios que sofreram alteração
  paraRepintar.forEach((cod) => repintarMunicipio(cod));
  atualizarPainelSelecao();
  atualizarPaletaCoresUsadas();
}

function carregarProjetoSalvo() {
  const bruto = localStorage.getItem(CHAVE_LOCALSTORAGE);
  if (!bruto) return;
  try {
    aplicarEstadoDoObjeto(JSON.parse(bruto));
  } catch (erro) {
    console.warn('Projeto salvo estava corrompido e foi ignorado:', erro);
  }
}

function exportarJSON() {
  const obj = estadoParaObjeto();
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mapa-brasil-projeto-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importarJSON(arquivo) {
  const leitor = new FileReader();
  leitor.onload = async () => {
    try {
      const obj = JSON.parse(leitor.result);
      aplicarEstadoDoObjeto(obj);
      salvarProjeto();
      await modalAlerta('Projeto importado com sucesso.');
    } catch (erro) {
      await modalAlerta('Arquivo inválido. Selecione um JSON exportado por esta aplicação.');
    }
  };
  leitor.readAsText(arquivo);
}

async function resetarTudo() {
  if (!(await modalConfirm('Isso apagará todas as cores, grupos, rotas, marcadores e textos. Continuar?'))) return;
  limparCamadasDinamicas(true);
  renderizarListaGrupos();
  renderizarListaRotas();
  renderizarListaMarcadores();
  renderizarListaTextos();
  repintarTodosMunicipios();
  atualizarPainelSelecao();
  atualizarPaletaCoresUsadas();
  localStorage.removeItem(CHAVE_LOCALSTORAGE);
  salvarProjeto();
}

// ---------------------------------------------------------------------------
// Exportar imagem PNG
// ---------------------------------------------------------------------------
// Como o mapa não usa camada de tiles (fundo branco puro) e todas as
// camadas vetoriais (estados, mesorregiões, municípios e rotas) usam o
// mesmo renderer Canvas, basta copiar esse canvas para uma imagem final
// e desenhar por cima, manualmente, os marcadores e textos (que são
// elementos HTML/divIcon e por isso não aparecem no canvas).

async function exportarPNG() {
  const canvasOrigem = rendererCompartilhado._container;
  if (!canvasOrigem) { await modalAlerta('O mapa ainda não está pronto para exportação.'); return; }

  const mapaDiv = document.getElementById('mapa');
  const escala = canvasOrigem.width / mapaDiv.clientWidth;

  const canvasFinal = document.createElement('canvas');
  canvasFinal.width = canvasOrigem.width;
  canvasFinal.height = canvasOrigem.height;
  const ctx = canvasFinal.getContext('2d');

  // Fundo branco
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasFinal.width, canvasFinal.height);

  // Estados + mesorregiões + municípios + rotas (já desenhados no canvas do Leaflet)
  ctx.drawImage(canvasOrigem, 0, 0);

  // Marcadores (desenhados manualmente como um pino vermelho)
  marcadores.forEach((m) => {
    const p = mapa.latLngToContainerPoint([m.lat, m.lng]);
    const x = p.x * escala, y = p.y * escala;
    ctx.beginPath();
    ctx.arc(x, y - 6 * escala, 8 * escala, 0, Math.PI * 2);
    ctx.fillStyle = '#e14b4b';
    ctx.fill();
    ctx.lineWidth = 2 * escala;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  });

  // Textos livres
  ctx.font = `${12 * escala}px Segoe UI, Arial, sans-serif`;
  ctx.textBaseline = 'middle';
  textos.forEach((t) => {
    const p = mapa.latLngToContainerPoint([t.lat, t.lng]);
    const x = p.x * escala, y = p.y * escala;
    const largura = ctx.measureText(t.texto).width;
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fillRect(x - 4 * escala, y - 10 * escala, largura + 8 * escala, 20 * escala);
    ctx.strokeStyle = '#d7dce3';
    ctx.strokeRect(x - 4 * escala, y - 10 * escala, largura + 8 * escala, 20 * escala);
    ctx.fillStyle = '#22262b';
    ctx.fillText(t.texto, x, y);
  });

  canvasFinal.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mapa-brasil-${new Date().toISOString().slice(0, 10)}.png`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

// ---------------------------------------------------------------------------
// Camadas: checkboxes de visibilidade
// ---------------------------------------------------------------------------

function aplicarVisibilidadeCamadas() {
  const alternar = (chkId, layer) => {
    const marcado = document.getElementById(chkId).checked;
    if (marcado && !mapa.hasLayer(layer)) mapa.addLayer(layer);
    if (!marcado && mapa.hasLayer(layer)) mapa.removeLayer(layer);
  };
  alternar('chk-estados', camadaEstados);
  alternar('chk-mesorregioes', camadaMesorregioes);
  alternar('chk-rotulos-estados', camadaRotulosEstados);
  alternar('chk-rotulos-mesorregioes', camadaRotulosMesorregioes);

  // A camada de municípios permanece sempre adicionada ao mapa para que os municípios
  // pintados/coloridos continuem visíveis da mesma forma mesmo ao desmarcar os contornos.
  if (!mapa.hasLayer(camadaMunicipios)) {
    mapa.addLayer(camadaMunicipios);
  }
  atualizarRotulosVisiveis();
  repintarTodosMunicipios();
}

['chk-estados', 'chk-mesorregioes', 'chk-municipios', 'chk-rotulos-estados', 'chk-rotulos-mesorregioes']
  .forEach((id) => document.getElementById(id).addEventListener('change', () => { aplicarVisibilidadeCamadas(); }));

// ---------------------------------------------------------------------------
// Filtro por estado (visão geral x foco em um único estado)
// ---------------------------------------------------------------------------

document.getElementById('filtro-estado').addEventListener('change', (e) => {
  estadoFiltroAtual = e.target.value || null;
  if (estadoFiltroAtual && boundsPorUF.has(estadoFiltroAtual)) {
    mapa.fitBounds(boundsPorUF.get(estadoFiltroAtual), { padding: [20, 20] });
  } else if (boundsBrasil) {
    mapa.fitBounds(boundsBrasil, { padding: [10, 10] });
  }
  repintarTodosMunicipios();
  camadaEstadosGeo.setStyle(estiloEstado);
  camadaMesorregioesGeo.setStyle(estiloMesorregiao);
  atualizarRotulosVisiveis();
  atualizarVisibilidadeItensUsuario();
  atualizarSelectMesorregioes();
  renderizarListaGrupos();
});

const inputBuscaGrupo = document.getElementById('busca-grupo');
if (inputBuscaGrupo) {
  inputBuscaGrupo.addEventListener('input', () => {
    renderizarListaGrupos();
  });
}

// ---------------------------------------------------------------------------
// Multi-seleção "pintando" com Shift + cursor do mouse
// ---------------------------------------------------------------------------
// Segurando Shift e passando o cursor por cima dos municípios (com o botão
// do mouse pressionado), cada município que o cursor efetivamente tocar é
// adicionado à seleção — diferente de uma seleção por área/retângulo, que
// pegaria também vizinhos que não deveriam entrar. O arraste normal do
// mapa (sem Shift) continua funcionando para navegar, pois o Leaflet
// ignora o início do arraste quando a tecla Shift está pressionada.

let arrastandoComShiftAtivo = false;

mapa.getContainer().addEventListener('mousedown', (e) => {
  if (e.shiftKey && modoAtual === 'selecionar' && e.button === 0) {
    arrastandoComShiftAtivo = true;
    e.preventDefault(); // evita seleção de texto na página durante o arraste
  }
});

document.addEventListener('mouseup', () => { arrastandoComShiftAtivo = false; });
document.addEventListener('keyup', (e) => { if (e.key === 'Shift') arrastandoComShiftAtivo = false; });

// ---------------------------------------------------------------------------
// Ligação da interface (abas, botões, ferramentas)
// ---------------------------------------------------------------------------

document.querySelectorAll('.aba-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.aba-btn').forEach((b) => b.classList.remove('ativo'));
    document.querySelectorAll('.aba-conteudo').forEach((c) => c.classList.add('oculto'));
    btn.classList.add('ativo');
    document.getElementById(`aba-${btn.dataset.aba}`).classList.remove('oculto');
  });
});

document.getElementById('btn-selecionar').setAttribute('data-modo', 'selecionar');
document.getElementById('btn-mesorregiao').setAttribute('data-modo', 'mesorregiao');
document.getElementById('btn-pipeta').setAttribute('data-modo', 'pipeta');
document.getElementById('btn-rota').setAttribute('data-modo', 'rota');
document.getElementById('btn-marcador').setAttribute('data-modo', 'marcador');
document.getElementById('btn-texto').setAttribute('data-modo', 'texto');

document.getElementById('btn-selecionar').addEventListener('click', () => definirModo('selecionar'));
document.getElementById('btn-mesorregiao').addEventListener('click', () => {
  definirModo(modoAtual === 'mesorregiao' ? 'selecionar' : 'mesorregiao');
});
document.getElementById('btn-pipeta').addEventListener('click', () => {
  definirModo(modoAtual === 'pipeta' ? 'selecionar' : 'pipeta');
});
document.getElementById('btn-rota').addEventListener('click', () => definirModo('rota'));
document.getElementById('btn-marcador').addEventListener('click', () => definirModo('marcador'));
document.getElementById('btn-texto').addEventListener('click', () => definirModo('texto'));
document.getElementById('btn-finalizar').addEventListener('click', finalizarRota);
document.getElementById('btn-limpar-selecao').addEventListener('click', limparSelecao);

document.getElementById('btn-multi').addEventListener('click', (e) => {
  multiSelecaoAtiva = !multiSelecaoAtiva;
  e.target.classList.toggle('ativo', multiSelecaoAtiva);
  definirModo('selecionar');
});

document.getElementById('btn-aplicar-cor').addEventListener('click', aplicarCorSelecionados);
document.getElementById('btn-remover-cor').addEventListener('click', removerCorSelecionados);
document.getElementById('btn-copiar-cor').addEventListener('click', copiarCorDoSelecionado);
document.getElementById('btn-selecionar-mesma-cor').addEventListener('click', () => selecionarMunicipiosComMesmaCor());

document.getElementById('btn-selecionar-meso').addEventListener('click', () => {
  const cod = document.getElementById('select-mesorregiao').value;
  if (!cod) { modalAlerta('Selecione uma mesorregião na lista.'); return; }
  selecionarMesorregiao(cod, multiSelecaoAtiva);
});

document.getElementById('btn-pintar-meso').addEventListener('click', () => {
  const cod = document.getElementById('select-mesorregiao').value;
  if (!cod) { modalAlerta('Selecione uma mesorregião na lista.'); return; }
  const cor = document.getElementById('cor-individual').value;
  pintarMesorregiao(cod, cor);
  const info = mesorregioesInfo.get(cod);
  if (window.AppColaboracao?.mostrarToast) {
    window.AppColaboracao.mostrarToast(`Mesorregião ${info ? info.nome : ''} pintada com ${cor}!`);
  }
});

document.getElementById('btn-criar-grupo').addEventListener('click', criarGrupoComSelecionados);
document.getElementById('btn-remover-grupo').addEventListener('click', removerSelecionadosDosGrupos);

document.getElementById('btn-exportar-json').addEventListener('click', exportarJSON);
document.getElementById('btn-exportar-png').addEventListener('click', exportarPNG);
document.getElementById('btn-resetar').addEventListener('click', resetarTudo);

const btnRecarregarNuvem = document.getElementById('btn-recarregar-nuvem');
if (btnRecarregarNuvem) {
  btnRecarregarNuvem.addEventListener('click', () => {
    if (window.AppColaboracao && typeof window.AppColaboracao.forcarCarregamentoNuvem === 'function') {
      window.AppColaboracao.forcarCarregamentoNuvem();
    }
  });
}

document.getElementById('input-importar-json').addEventListener('change', (e) => {
  if (e.target.files[0]) importarJSON(e.target.files[0]);
  e.target.value = '';
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (modoAtual === 'rota') cancelarRotaEmAndamento();
    definirModo('selecionar');
  }
});

// Exporta referências para integração com colaboração em tempo real
window.AppMapa = {
  mapa,
  estadoParaObjeto,
  aplicarEstadoDoObjeto,
  aplicarEstadoRemoto,
  salvarProjeto,
  repintarTodosMunicipios,
  atualizarPainelSelecao,
  limparCamadasDinamicas,
  selecionarMesorregiao,
  pintarMesorregiao,
  selecionarMunicipiosComMesmaCor,
  atualizarPaletaCoresUsadas,
  copiarCorDoSelecionado
};

// ---------------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------------

(async function iniciar() {
  await carregarCamadas();
  carregarProjetoSalvo();
  definirModo('selecionar');
  window.dispatchEvent(new CustomEvent('appMapaPronto'));
})();

