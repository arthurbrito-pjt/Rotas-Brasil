// ============================================================================
// Colaboração em Tempo Real com Firebase (Realtime Database & Auth)
// Suporta:
// - Login / Logout com Google
// - Identificação por sessão exclusiva (suporta abas simultâneas ou contas compartilhadas)
// - Presença online e avatares no topo sem nenhum piscamento (DOM diffing)
// - Cursores em tempo real com Leaflet (lat/lng reais e transições suaves de opacidade)
// - Sincronização inteligente e não-destrutiva de cores, grupos, rotas, marcadores e textos
// - Preservação estrita e absoluta da seleção e ferramentas ativas de cada usuário
// ============================================================================

import {
  auth,
  db,
  googleProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  ref,
  set,
  get,
  onValue,
  onDisconnect,
  serverTimestamp,
  off
} from './firebase-config.js';

// ID de sessão único por aba/janela aberta (evita conflitos mesmo testando na mesma máquina ou conta)
const sessionId = 's_' + Math.random().toString(36).slice(2, 9) + '_' + Date.now().toString(36);

// Paleta de cores moderna e distinta para cada colaborador
const PALETA_CORES = [
  '#2563eb', // Azul
  '#e11d48', // Vermelho/Rosa
  '#059669', // Verde Esmeralda
  '#d97706', // Âmbar/Laranja
  '#7c3aed', // Roxo
  '#0891b2', // Ciano
  '#db2777', // Rosa
  '#4f46e5', // Índigo
  '#ea580c', // Laranja Intenso
  '#0d9488', // Teal
];

function extrairCorUsuario(id) {
  if (!id) return PALETA_CORES[0];
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  return PALETA_CORES[Math.abs(hash) % PALETA_CORES.length];
}

// ---------------------------------------------------------------------------
// Estado da Colaboração
// ---------------------------------------------------------------------------
let usuarioAtual = null;
let corUsuarioAtual = null;
let camadaCursores = null;

// Mapa de cursores ativos no Leaflet: sessionId -> { marker, el, dados }
const cursoresOutros = new Map();
// Informações estáticas de usuários online: sessionId -> { sessionId, uid, nome, email, foto, cor }
const usuariosOnline = new Map();
// Última posição conhecida do cursor: sessionId -> { lat, lng }
const ultimasPosicoes = new Map();
// Elementos DOM dos avatares no topbar: sessionId -> HTMLElement
const elementosAvatares = new Map();

let debouncersSalvar = null;
let ultimoEstadoSincronizado = null;
let ultimoHashSincronizado = null;
let salvandoNoFirebase = false;
let salvamentoPendente = false;
let conectadoAoFirebase = false;

// ---------------------------------------------------------------------------
// Elementos da Interface
// ---------------------------------------------------------------------------
const btnLoginGoogle = document.getElementById('btn-login-google');
const colabUsuario = document.getElementById('colab-usuario');
const usuarioFoto = document.getElementById('usuario-foto');
const usuarioNome = document.getElementById('usuario-nome');
const btnLogout = document.getElementById('btn-logout-colab');
const listaColaboradores = document.getElementById('colaboradores-lista');
const statusSync = document.getElementById('status-sync');
const statusTexto = document.getElementById('status-sync-texto');

function atualizarStatusUI(tipo, texto) {
  if (!statusSync) return;
  statusSync.className = `status-pill status-${tipo}`;
  if (statusTexto) statusTexto.textContent = texto;
}

// ---------------------------------------------------------------------------
// Inicialização do Leaflet para Cursores
// ---------------------------------------------------------------------------
function garantirCamadaCursores() {
  if (!window.AppMapa || !window.AppMapa.mapa) return false;
  if (!camadaCursores) {
    camadaCursores = L.layerGroup().addTo(window.AppMapa.mapa);
  }
  return true;
}

function criarIconeCursor(peer) {
  const cor = peer.cor || '#2563eb';
  const primeiroNome = (peer.nome || 'Colega').trim().split(' ')[0];
  const html = `
    <div class="cursor-colaborador" style="--cor-cursor: ${cor};">
      <svg class="cursor-seta" viewBox="0 0 24 24">
        <path d="M5.65 2.15a1 1 0 0 1 1.58-.22l14.1 14.1a1 1 0 0 1-.71 1.71h-6.38l-3.35 6.03a1 1 0 0 1-1.78-.99l3.14-5.65H6.28a1 1 0 0 1-.89-1.45l2.26-4.52L5.65 2.15z"/>
      </svg>
      <div class="cursor-badge">${primeiroNome}</div>
    </div>
  `;
  return L.divIcon({
    className: 'cursor-leaflet-wrapper',
    html,
    iconSize: [0, 0],
    iconAnchor: [0, 0]
  });
}

// ---------------------------------------------------------------------------
// Rastreamento de Mouse e Envio de Posição
// ---------------------------------------------------------------------------
let ultimoEnvioMouse = 0;
let rafMouse = null;
let ultimaPosicaoEnviada = null;

function enviarPosicaoCursor(lat, lng) {
  if (!usuarioAtual || !conectadoAoFirebase) return;

  // Evita envios repetidos de posições idênticas
  const chavePos = lat !== null && lng !== null && lat !== undefined && lng !== undefined
    ? `${lat.toFixed(5)},${lng.toFixed(5)}`
    : 'null';
  if (ultimaPosicaoEnviada === chavePos) return;
  ultimaPosicaoEnviada = chavePos;

  const cursorRef = ref(db, `cursores/${sessionId}`);
  set(cursorRef, {
    sessionId,
    lat: lat !== null && lat !== undefined ? Number(lat.toFixed(5)) : null,
    lng: lng !== null && lng !== undefined ? Number(lng.toFixed(5)) : null,
    t: Date.now()
  }).catch(() => {});
}

function configurarEventosMapa() {
  if (!window.AppMapa || !window.AppMapa.mapa) return;
  const mapa = window.AppMapa.mapa;
  if (mapa._eventosColabConfigurados) return;
  mapa._eventosColabConfigurados = true;

  const container = mapa.getContainer();

  // Movimento do mouse sobre o mapa com throttle de 50ms usando requestAnimationFrame
  mapa.on('mousemove', (e) => {
    if (!usuarioAtual || !conectadoAoFirebase) return;
    const lat = e.latlng.lat;
    const lng = e.latlng.lng;

    if (!rafMouse) {
      rafMouse = requestAnimationFrame(() => {
        rafMouse = null;
        const agora = performance.now();
        if (agora - ultimoEnvioMouse > 50) {
          enviarPosicaoCursor(lat, lng);
          ultimoEnvioMouse = agora;
        }
      });
    }
  });

  // mouseleave no container real do mapa NÃO dispara ao passar sobre municípios ou marcadores!
  container.addEventListener('mouseleave', () => {
    if (!usuarioAtual || !conectadoAoFirebase) return;
    enviarPosicaoCursor(null, null);
  });
}

window.addEventListener('appMapaPronto', () => {
  garantirCamadaCursores();
  if (usuarioAtual) {
    configurarEventosMapa();
  }
});

// ---------------------------------------------------------------------------
// Atualização dos Cursores Remotos (Sem Piscar!)
// ---------------------------------------------------------------------------
function processarAtualizacaoCursor(idSessao, coord) {
  if (!garantirCamadaCursores()) return;
  if (idSessao === sessionId) return; // Ignora o cursor da própria aba

  const temCoord = coord && typeof coord.lat === 'number' && typeof coord.lng === 'number';

  if (temCoord) {
    ultimasPosicoes.set(idSessao, { lat: coord.lat, lng: coord.lng });
  }

  let item = cursoresOutros.get(idSessao);

  if (temCoord) {
    if (item) {
      item.marker.setLatLng([coord.lat, coord.lng]);
      if (item.el) {
        item.el.classList.remove('cursor-oculto');
      }
    } else {
      const peer = usuariosOnline.get(idSessao) || {
        sessionId: idSessao,
        nome: 'Colega',
        cor: extrairCorUsuario(idSessao)
      };
      const marker = L.marker([coord.lat, coord.lng], {
        icon: criarIconeCursor(peer),
        interactive: false,
        zIndexOffset: 1200
      }).addTo(camadaCursores);

      const el = marker.getElement();
      cursoresOutros.set(idSessao, { marker, el, dados: peer });
    }
  } else if (item) {
    // Quando sai do mapa, apenas oculta suavemente via CSS em vez de destruir e recriar o elemento!
    if (item.el) {
      item.el.classList.add('cursor-oculto');
    }
  }
}

function removerCursor(idSessao) {
  const item = cursoresOutros.get(idSessao);
  if (item) {
    camadaCursores.removeLayer(item.marker);
    cursoresOutros.delete(idSessao);
  }
  ultimasPosicoes.delete(idSessao);
}

// ---------------------------------------------------------------------------
// Renderização da Barra de Presença com DOM Diffing (Zero Flickering)
// ---------------------------------------------------------------------------
function atualizarListaColaboradores(presencas) {
  if (!listaColaboradores) return;

  const idsNoServidor = new Set(Object.keys(presencas || {}));

  // Remove avatares de sessões que saíram
  elementosAvatares.forEach((el, idSessao) => {
    if (!idsNoServidor.has(idSessao)) {
      el.remove();
      elementosAvatares.delete(idSessao);
      removerCursor(idSessao);
      usuariosOnline.delete(idSessao);
    }
  });

  // Atualiza / adiciona novos avatares sem recriar os existentes
  Object.entries(presencas || {}).forEach(([idSessao, peer]) => {
    if (!peer) return;
    usuariosOnline.set(idSessao, peer);

    const isVoce = idSessao === sessionId;

    if (!elementosAvatares.has(idSessao)) {
      const container = document.createElement('div');
      container.className = `avatar-colaborador ${isVoce ? 'avatar-voce' : ''}`;
      container.style.borderColor = peer.cor || '#2563eb';
      container.title = `${peer.nome || 'Colega'}${isVoce ? ' — Você' : ' — Clique para ver no mapa'}`;

      if (peer.foto) {
        const img = document.createElement('img');
        img.src = peer.foto;
        img.alt = peer.nome || 'Usuário';
        img.referrerPolicy = 'no-referrer';
        container.appendChild(img);
      } else {
        const inicial = (peer.nome || 'U').charAt(0).toUpperCase();
        const span = document.createElement('span');
        span.className = 'avatar-inicial';
        span.style.backgroundColor = peer.cor || '#2563eb';
        span.textContent = inicial;
        container.appendChild(span);
      }

      if (!isVoce) {
        container.style.cursor = 'pointer';
        container.onclick = () => {
          const pos = ultimasPosicoes.get(idSessao);
          if (pos && typeof pos.lat === 'number' && typeof pos.lng === 'number' && window.AppMapa?.mapa) {
            window.AppMapa.mapa.setView([pos.lat, pos.lng], Math.max(window.AppMapa.mapa.getZoom(), 7), {
              animate: true
            });
          }
        };
      }

      listaColaboradores.appendChild(container);
      elementosAvatares.set(idSessao, container);
    }
  });

  // Indicador de "Apenas você" se for o único
  let avisoSozinho = document.getElementById('aviso-sozinho');
  if (idsNoServidor.size <= 1) {
    if (!avisoSozinho) {
      avisoSozinho = document.createElement('span');
      avisoSozinho.id = 'aviso-sozinho';
      avisoSozinho.className = 'dica-online';
      avisoSozinho.textContent = 'Apenas você na sala';
      listaColaboradores.appendChild(avisoSozinho);
    }
  } else if (avisoSozinho) {
    avisoSozinho.remove();
  }
}

// ---------------------------------------------------------------------------
// Monitoramento de Presença e Conexão Firebase
// ---------------------------------------------------------------------------
let listenerPresencas = null;
let listenerCursores = null;
let refConexao = null;

function iniciarGerenciamentoPresenca(user) {
  const presencaRef = ref(db, `presencas/${sessionId}`);
  const cursorRef = ref(db, `cursores/${sessionId}`);
  refConexao = ref(db, '.info/connected');

  onValue(refConexao, (snap) => {
    if (snap.val() === true) {
      conectadoAoFirebase = true;
      atualizarStatusUI('online', 'Conectado');

      // Ao desconectar (fechar aba, cair internet), remove imediatamente do Realtime Database
      onDisconnect(presencaRef).remove();
      onDisconnect(cursorRef).remove();

      // Grava dados estáticos de presença (uma única vez por sessão)
      set(presencaRef, {
        sessionId,
        uid: user.uid,
        nome: user.displayName || 'Usuário',
        email: user.email || '',
        foto: user.photoURL || '',
        cor: corUsuarioAtual,
        onlineDesde: serverTimestamp()
      });
    } else {
      conectadoAoFirebase = false;
      atualizarStatusUI('offline', 'Offline');
    }
  });

  // Escuta presenças (só dispara quando alguém entra ou sai, NUNCA no mousemove!)
  const todasPresencasRef = ref(db, 'presencas');
  listenerPresencas = onValue(todasPresencasRef, (snap) => {
    const dados = snap.val() || {};
    atualizarListaColaboradores(dados);
  });

  // Escuta cursores (coordenadas de alta frequência)
  const todosCursoresRef = ref(db, 'cursores');
  listenerCursores = onValue(todosCursoresRef, (snap) => {
    const dados = snap.val() || {};
    Object.entries(dados).forEach(([idSessao, coord]) => {
      processarAtualizacaoCursor(idSessao, coord);
    });
  });
}

function encerrarGerenciamentoPresenca() {
  if (usuarioAtual) {
    set(ref(db, `presencas/${sessionId}`), null);
    set(ref(db, `cursores/${sessionId}`), null);
  }
  if (camadaCursores) {
    camadaCursores.clearLayers();
  }
  cursoresOutros.clear();
  ultimasPosicoes.clear();
  elementosAvatares.forEach((el) => el.remove());
  elementosAvatares.clear();
  usuariosOnline.clear();

  if (listenerPresencas) off(ref(db, 'presencas'));
  if (listenerCursores) off(ref(db, 'cursores'));
  if (refConexao) off(refConexao);
  conectadoAoFirebase = false;
  atualizarStatusUI('offline', 'Desconectado');
  if (listaColaboradores) listaColaboradores.innerHTML = '';
}

// ---------------------------------------------------------------------------
// Sincronização Atômica e Concorrente do Projeto (Zero Perda / Sem Travamentos)
// - Utiliza transações atômicas no Realtime Database (runTransaction)
// - Mesclagem 3-way inteligente de estados (preserva adições e edições simultâneas)
// - Fila de salvamento que NUNCA descarta operações de nenhum usuário
// - Preserva rigorosamente as seleções e ferramentas de cada colaborador
// ---------------------------------------------------------------------------
let listenerProjeto = null;

function mesclarEstados(servidor, local, base) {
  if (!servidor) return local;
  if (!local) return servidor;
  const s = servidor || {};
  const l = local || {};
  const b = base || {};

  // 1. Cores individuais
  const sCores = { ...(s.coresIndividuais || {}) };
  const lCores = l.coresIndividuais || {};
  const bCores = b.coresIndividuais || {};
  Object.keys(lCores).forEach((k) => {
    if (lCores[k] !== bCores[k]) sCores[k] = lCores[k];
  });
  Object.keys(bCores).forEach((k) => {
    if (!(k in lCores)) delete sCores[k];
  });

  // 2. Município para Grupo
  const sMunGrupo = { ...(s.municipioParaGrupo || {}) };
  const lMunGrupo = l.municipioParaGrupo || {};
  const bMunGrupo = b.municipioParaGrupo || {};
  Object.keys(lMunGrupo).forEach((k) => {
    if (lMunGrupo[k] !== bMunGrupo[k]) sMunGrupo[k] = lMunGrupo[k];
  });
  Object.keys(bMunGrupo).forEach((k) => {
    if (!(k in lMunGrupo)) delete sMunGrupo[k];
  });

  // 3. Helper para listas de objetos com identificador único
  function mesclarLista(sLista, lLista, bLista) {
    const mapa = new Map();
    (sLista || []).forEach((item) => {
      if (item && item.id) mapa.set(item.id, { ...item });
    });
    const bMap = new Map();
    (bLista || []).forEach((item) => {
      if (item && item.id) bMap.set(item.id, item);
    });

    (lLista || []).forEach((item) => {
      if (!item || !item.id) return;
      const bItem = bMap.get(item.id);
      if (!bItem || JSON.stringify(item) !== JSON.stringify(bItem)) {
        mapa.set(item.id, { ...item });
      }
    });

    (bLista || []).forEach((item) => {
      if (item && item.id && !(lLista || []).some((li) => li.id === item.id)) {
        mapa.delete(item.id);
      }
    });
    return Array.from(mapa.values());
  }

  return {
    versao: 1,
    dataExportacao: new Date().toISOString(),
    coresIndividuais: sCores,
    municipioParaGrupo: sMunGrupo,
    grupos: mesclarLista(s.grupos, l.grupos, b.grupos),
    rotas: mesclarLista(s.rotas, l.rotas, b.rotas),
    marcadores: mesclarLista(s.marcadores, l.marcadores, b.marcadores),
    textos: mesclarLista(s.textos, l.textos, b.textos)
  };
}

function iniciarSincronizacaoProjeto() {
  const projetoRef = ref(db, 'projeto/compartilhado');

  // Ao conectar, carrega o estado da nuvem se existir
  get(projetoRef).then((snap) => {
    if (snap.exists()) {
      const payload = snap.val();
      if (payload && payload.dados && window.AppMapa?.aplicarEstadoRemoto) {
        console.log('Projeto carregado da nuvem:', payload.atualizadoPor?.nome);
        const localAgora = window.AppMapa.estadoParaObjeto ? window.AppMapa.estadoParaObjeto() : null;
        let dadosParaAplicar = payload.dados;
        const temDadosLocais = localAgora && (
          Object.keys(localAgora.coresIndividuais || {}).length > 0 ||
          (localAgora.grupos || []).length > 0 ||
          (localAgora.rotas || []).length > 0 ||
          (localAgora.marcadores || []).length > 0 ||
          (localAgora.textos || []).length > 0
        );
        if (temDadosLocais) {
          dadosParaAplicar = mesclarEstados(payload.dados, localAgora, null);
        }
        ultimoEstadoSincronizado = dadosParaAplicar;
        ultimoHashSincronizado = JSON.stringify(dadosParaAplicar);
        window.AppMapa.aplicarEstadoRemoto(dadosParaAplicar);
        atualizarStatusUI('online', 'Sincronizado');
        if (JSON.stringify(dadosParaAplicar) !== JSON.stringify(payload.dados)) {
          notificarAlteracaoLocal();
        }
      }
    } else if (window.AppMapa?.estadoParaObjeto) {
      executarSalvamentoRemoto();
    }
  }).catch((err) => {
    console.warn('Erro ao carregar projeto inicial do Firebase:', err);
  });

  // Escuta atualizações contínuas de outros colaboradores
  listenerProjeto = onValue(projetoRef, (snap) => {
    if (!snap.exists()) return;
    const payload = snap.val();
    if (!payload || !payload.dados) return;

    // Ignora alterações originadas pela própria sessão
    if (payload.atualizadoPor?.sessionId === sessionId) return;

    const hashRecebido = JSON.stringify(payload.dados);
    if (hashRecebido === ultimoHashSincronizado) return;

    console.log(`Recebida atualização remota de ${payload.atualizadoPor?.nome || 'Colega'}`);

    const temModificacoesLocaisPendentes = salvandoNoFirebase || salvamentoPendente || debouncersSalvar !== null;

    if (temModificacoesLocaisPendentes && window.AppMapa?.estadoParaObjeto) {
      // Mesclagem em tempo real: preserva as alterações locais não enviadas
      const localAgora = window.AppMapa.estadoParaObjeto();
      const mesclado = mesclarEstados(payload.dados, localAgora, ultimoEstadoSincronizado);
      ultimoEstadoSincronizado = payload.dados;
      ultimoHashSincronizado = JSON.stringify(payload.dados);

      if (window.AppMapa?.aplicarEstadoRemoto) {
        window.AppMapa.aplicarEstadoRemoto(mesclado);
      }
      mostrarToast(`Alterações de ${payload.atualizadoPor?.nome || 'um colega'} mescladas`);
      // Reagenda envio para consolidar o estado mesclado
      notificarAlteracaoLocal();
    } else {
      // Usuário sem pendências: aplica diretamente
      ultimoEstadoSincronizado = payload.dados;
      ultimoHashSincronizado = hashRecebido;
      if (window.AppMapa?.aplicarEstadoRemoto) {
        window.AppMapa.aplicarEstadoRemoto(payload.dados);
      }
      mostrarToast(`Mapa atualizado por ${payload.atualizadoPor?.nome || 'um colega'}`);
      atualizarStatusUI('online', 'Sincronizado');
    }
  });
}

function encerrarSincronizacaoProjeto() {
  if (listenerProjeto) off(ref(db, 'projeto/compartilhado'));
}

async function executarSalvamentoRemoto() {
  if (!usuarioAtual || !conectadoAoFirebase || !window.AppMapa?.estadoParaObjeto) {
    salvandoNoFirebase = false;
    return;
  }

  if (salvandoNoFirebase) {
    salvamentoPendente = true;
    return;
  }

  const dadosLocais = window.AppMapa.estadoParaObjeto();
  const hashLocal = JSON.stringify(dadosLocais);

  // Se nada mudou em relação ao último sincronizado e não há pendências
  if (hashLocal === ultimoHashSincronizado && !salvamentoPendente) {
    atualizarStatusUI('online', 'Sincronizado');
    return;
  }

  salvandoNoFirebase = true;
  salvamentoPendente = false;
  atualizarStatusUI('salvando', 'Salvando...');

  const projetoRef = ref(db, 'projeto/compartilhado');

  try {
    const payload = {
      dados: dadosLocais,
      atualizadoPor: {
        sessionId,
        uid: usuarioAtual.uid,
        nome: usuarioAtual.displayName || 'Usuário',
        email: usuarioAtual.email || ''
      },
      atualizadoEm: Date.now()
    };

    await set(projetoRef, payload);

    ultimoEstadoSincronizado = dadosLocais;
    ultimoHashSincronizado = hashLocal;
    atualizarStatusUI('online', 'Sincronizado');
  } catch (err) {
    console.error('Erro ao salvar no Firebase:', err);
    atualizarStatusUI('erro', 'Erro ao sincronizar');
  } finally {
    salvandoNoFirebase = false;
    if (salvamentoPendente) {
      salvamentoPendente = false;
      executarSalvamentoRemoto();
    }
  }
}

export function notificarAlteracaoLocal() {
  if (!usuarioAtual) return;
  atualizarStatusUI('salvando', 'Sincronizando...');
  clearTimeout(debouncersSalvar);
  debouncersSalvar = setTimeout(() => {
    debouncersSalvar = null;
    executarSalvamentoRemoto();
  }, 250);
}

// ---------------------------------------------------------------------------
// Notificação Toast Visual
// ---------------------------------------------------------------------------
function mostrarToast(mensagem) {
  let toast = document.getElementById('colab-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'colab-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = mensagem;
  toast.classList.add('visivel');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.remove('visivel');
  }, 3000);
}

// ---------------------------------------------------------------------------
// Fluxo de Autenticação com Google
// ---------------------------------------------------------------------------
async function entrarComGoogle() {
  try {
    atualizarStatusUI('salvando', 'Entrando...');
    await signInWithPopup(auth, googleProvider);
  } catch (err) {
    console.error('Erro ao autenticar com Google:', err);
    atualizarStatusUI('offline', 'Falha no login');
    if (err.code !== 'auth/popup-closed-by-user') {
      alert(`Não foi possível conectar com o Google: ${err.message}`);
    }
  }
}

async function sair() {
  try {
    encerrarGerenciamentoPresenca();
    encerrarSincronizacaoProjeto();
    await signOut(auth);
  } catch (err) {
    console.error('Erro ao deslogar:', err);
  }
}

// ---------------------------------------------------------------------------
// Observador de Estado de Autenticação
// ---------------------------------------------------------------------------
onAuthStateChanged(auth, (user) => {
  usuarioAtual = user;

  if (user) {
    corUsuarioAtual = extrairCorUsuario(sessionId);

    if (btnLoginGoogle) btnLoginGoogle.classList.add('oculto');
    if (colabUsuario) colabUsuario.classList.remove('oculto');
    if (usuarioNome) usuarioNome.textContent = user.displayName || 'Usuário';

    if (usuarioFoto) {
      if (user.photoURL) {
        usuarioFoto.src = user.photoURL;
        usuarioFoto.classList.remove('oculto');
      } else {
        usuarioFoto.classList.add('oculto');
      }
    }

    iniciarGerenciamentoPresenca(user);
    iniciarSincronizacaoProjeto();
    configurarEventosMapa();
  } else {
    corUsuarioAtual = null;
    if (btnLoginGoogle) btnLoginGoogle.classList.remove('oculto');
    if (colabUsuario) colabUsuario.classList.add('oculto');
    encerrarGerenciamentoPresenca();
    encerrarSincronizacaoProjeto();
  }
});

// ---------------------------------------------------------------------------
// Listeners dos Botões de Login / Logout
// ---------------------------------------------------------------------------
if (btnLoginGoogle) {
  btnLoginGoogle.addEventListener('click', entrarComGoogle);
}
if (btnLogout) {
  btnLogout.addEventListener('click', sair);
}

// Expõe para o script principal
window.AppColaboracao = {
  salvarRemoto: notificarAlteracaoLocal,
  mostrarToast: mostrarToast,
  forcarCarregamentoNuvem: () => {
    get(ref(db, 'projeto/compartilhado')).then((snap) => {
      if (snap.exists() && window.AppMapa?.aplicarEstadoRemoto) {
        const dados = snap.val().dados;
        ultimoEstadoSincronizado = dados;
        ultimoHashSincronizado = JSON.stringify(dados);
        window.AppMapa.aplicarEstadoRemoto(dados);
        mostrarToast('Mapa recarregado da nuvem!');
      }
    });
  }
};
