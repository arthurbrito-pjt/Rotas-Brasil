// ============================================================================
// Colaboração em Tempo Real com Firebase (Realtime Database & Auth)
// Suporta:
// - Login / Logout com Google
// - Presença online de múltiplos usuários simultâneos
// - Cursores ao vivo no mapa Leaflet (com coordenadas lat/lng reais)
// - Sincronização em tempo real de cores, grupos, rotas, marcadores e textos
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

function extrairCorUsuario(uid) {
  if (!uid) return PALETA_CORES[0];
  let hash = 0;
  for (let i = 0; i < uid.length; i++) {
    hash = uid.charCodeAt(i) + ((hash << 5) - hash);
  }
  return PALETA_CORES[Math.abs(hash) % PALETA_CORES.length];
}

// ---------------------------------------------------------------------------
// Estado da Colaboração
// ---------------------------------------------------------------------------
let usuarioAtual = null;
let corUsuarioAtual = null;
let camadaCursores = null;

// Mapa de cursores ativos de outros colaboradores: uid -> { marker, dados }
const cursoresOutros = new Map();
// Mapa de presenças ativas: uid -> dados
const presencasAtivas = new Map();

let debouncersSalvar = null;
let ultimoHashEstadoLocal = null;
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

// Criação do ícone SVG personalizado do cursor
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
let timeoutEnvioMouse = null;
let posicaoPendente = null;

function enviarPosicaoCursor(lat, lng) {
  if (!usuarioAtual || !conectadoAoFirebase) return;
  const cursorRef = ref(db, `presencas/${usuarioAtual.uid}`);
  set(cursorRef, {
    uid: usuarioAtual.uid,
    nome: usuarioAtual.displayName || 'Usuário',
    email: usuarioAtual.email || '',
    foto: usuarioAtual.photoURL || '',
    cor: corUsuarioAtual,
    lat: lat !== null && lat !== undefined ? Number(lat.toFixed(5)) : null,
    lng: lng !== null && lng !== undefined ? Number(lng.toFixed(5)) : null,
    ativo: true,
    atualizadoEm: Date.now()
  }).catch((err) => {
    console.warn('Erro ao atualizar posição do cursor:', err);
  });
}

function configurarEventosMapa() {
  if (!window.AppMapa || !window.AppMapa.mapa) return;
  const mapa = window.AppMapa.mapa;
  if (mapa._eventosColabConfigurados) return;
  mapa._eventosColabConfigurados = true;

  mapa.on('mousemove', (e) => {
    if (!usuarioAtual) return;
    const agora = performance.now();
    posicaoPendente = e.latlng;

    // Throttle de ~60ms para movimentação super suave sem sobrecarregar a rede
    if (agora - ultimoEnvioMouse > 60) {
      enviarPosicaoCursor(posicaoPendente.lat, posicaoPendente.lng);
      ultimoEnvioMouse = agora;
    } else if (!timeoutEnvioMouse) {
      timeoutEnvioMouse = setTimeout(() => {
        timeoutEnvioMouse = null;
        if (posicaoPendente) {
          enviarPosicaoCursor(posicaoPendente.lat, posicaoPendente.lng);
          ultimoEnvioMouse = performance.now();
        }
      }, 60);
    }
  });

  mapa.on('mouseout', () => {
    if (!usuarioAtual) return;
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
// Atualização dos Cursores de Outros Usuários
// ---------------------------------------------------------------------------
function atualizarCursoresRemotos(presencas) {
  if (!garantirCamadaCursores()) return;

  const uidsPresentes = new Set();

  Object.entries(presencas || {}).forEach(([uid, peer]) => {
    if (uid === usuarioAtual?.uid) return; // Ignora a si mesmo
    if (!peer || !peer.ativo) return;

    uidsPresentes.add(uid);

    const temCoordenadas = typeof peer.lat === 'number' && typeof peer.lng === 'number';

    if (cursoresOutros.has(uid)) {
      const item = cursoresOutros.get(uid);
      if (temCoordenadas) {
        item.marker.setLatLng([peer.lat, peer.lng]);
        item.dados = peer;
      } else {
        camadaCursores.removeLayer(item.marker);
        cursoresOutros.delete(uid);
      }
    } else if (temCoordenadas) {
      const marker = L.marker([peer.lat, peer.lng], {
        icon: criarIconeCursor(peer),
        interactive: false,
        zIndexOffset: 1200
      }).addTo(camadaCursores);

      cursoresOutros.set(uid, { marker, dados: peer });
    }
  });

  // Remove cursores de quem saiu
  cursoresOutros.forEach((item, uid) => {
    if (!uidsPresentes.has(uid)) {
      camadaCursores.removeLayer(item.marker);
      cursoresOutros.delete(uid);
    }
  });
}

// ---------------------------------------------------------------------------
// Renderização da Barra de Presença (Quem está online)
// ---------------------------------------------------------------------------
function renderizarListaColaboradores(presencas) {
  if (!listaColaboradores) return;
  listaColaboradores.innerHTML = '';

  const lista = Object.values(presencas || {}).filter((p) => p && p.uid);

  if (lista.length <= 1) {
    listaColaboradores.innerHTML = '<span class="dica-online">Apenas você na sala</span>';
    return;
  }

  lista.forEach((peer) => {
    const isVoce = peer.uid === usuarioAtual?.uid;
    const container = document.createElement('div');
    container.className = `avatar-colaborador ${isVoce ? 'avatar-voce' : ''}`;
    container.title = `${peer.nome || 'Colega'} (${peer.email || ''})${isVoce ? ' — Você' : ' — Clique para ir até ele'}`;
    container.style.borderColor = peer.cor || '#2563eb';

    if (peer.foto) {
      container.innerHTML = `<img src="${peer.foto}" alt="${peer.nome}" referrerpolicy="no-referrer" />`;
    } else {
      const inicial = (peer.nome || 'U').charAt(0).toUpperCase();
      container.innerHTML = `<span class="avatar-inicial" style="background-color:${peer.cor || '#2563eb'}">${inicial}</span>`;
    }

    if (!isVoce) {
      container.style.cursor = 'pointer';
      container.onclick = () => {
        if (typeof peer.lat === 'number' && typeof peer.lng === 'number' && window.AppMapa?.mapa) {
          window.AppMapa.mapa.setView([peer.lat, peer.lng], Math.max(window.AppMapa.mapa.getZoom(), 7), {
            animate: true
          });
        }
      };
    }

    listaColaboradores.appendChild(container);
  });
}

// ---------------------------------------------------------------------------
// Monitoramento de Presença e Conexão Firebase (.info/connected)
// ---------------------------------------------------------------------------
let listenerPresencas = null;
let refConexao = null;

function iniciarGerenciamentoPresenca(user) {
  const presencaRef = ref(db, `presencas/${user.uid}`);
  refConexao = ref(db, '.info/connected');

  onValue(refConexao, (snap) => {
    if (snap.val() === true) {
      conectadoAoFirebase = true;
      atualizarStatusUI('online', 'Conectado');

      // Ao desconectar (fechar aba, cair internet), remove imediatamente do Realtime Database
      onDisconnect(presencaRef).remove();

      // Grava status inicial
      set(presencaRef, {
        uid: user.uid,
        nome: user.displayName || 'Usuário',
        email: user.email || '',
        foto: user.photoURL || '',
        cor: corUsuarioAtual,
        lat: null,
        lng: null,
        ativo: true,
        conectadoEm: serverTimestamp()
      });
    } else {
      conectadoAoFirebase = false;
      atualizarStatusUI('offline', 'Offline');
    }
  });

  // Escuta todas as presenças ativas
  const todasPresencasRef = ref(db, 'presencas');
  listenerPresencas = onValue(todasPresencasRef, (snap) => {
    const dados = snap.val() || {};
    atualizarCursoresRemotos(dados);
    renderizarListaColaboradores(dados);
  });
}

function encerrarGerenciamentoPresenca() {
  if (usuarioAtual) {
    const presencaRef = ref(db, `presencas/${usuarioAtual.uid}`);
    set(presencaRef, null);
  }
  if (camadaCursores) {
    camadaCursores.clearLayers();
  }
  cursoresOutros.clear();
  presencasAtivas.clear();
  if (listenerPresencas) off(ref(db, 'presencas'));
  if (refConexao) off(refConexao);
  conectadoAoFirebase = false;
  atualizarStatusUI('offline', 'Desconectado');
  if (listaColaboradores) listaColaboradores.innerHTML = '';
}

// ---------------------------------------------------------------------------
// Sincronização do Projeto (Mapa / Cores / Rotas / Marcadores)
// ---------------------------------------------------------------------------
let listenerProjeto = null;
let ignorandoMudancaRemota = false;

function iniciarSincronizacaoProjeto() {
  const projetoRef = ref(db, 'projeto/compartilhado');

  // Ao conectar, verifica se já existe um projeto na nuvem
  get(projetoRef).then((snap) => {
    if (snap.exists()) {
      const payload = snap.val();
      if (payload && payload.dados && window.AppMapa?.aplicarEstadoDoObjeto) {
        console.log('Projeto carregado da nuvem:', payload.atualizadoPor?.nome);
        window.AppMapa.aplicarEstadoDoObjeto(payload.dados);
        ultimoHashEstadoLocal = JSON.stringify(payload.dados);
      }
    } else if (window.AppMapa?.estadoParaObjeto) {
      // Se a nuvem estiver vazia, sobe o projeto local atual
      salvarProjetoRemotoImediato();
    }
  }).catch((err) => {
    console.warn('Erro ao carregar projeto inicial do Firebase:', err);
  });

  // Escuta atualizações contínuas de outros colaboradores
  listenerProjeto = onValue(projetoRef, (snap) => {
    if (!snap.exists()) return;
    const payload = snap.val();
    if (!payload || !payload.dados) return;

    // Ignora alterações originadas pelo próprio usuário local
    if (payload.atualizadoPor?.uid === usuarioAtual?.uid) return;

    const hashRecebido = JSON.stringify(payload.dados);
    if (hashRecebido === ultimoHashEstadoLocal) return;

    console.log(`Recebida atualização remota de ${payload.atualizadoPor?.nome || 'Colega'}`);
    ignorandoMudancaRemota = true;
    try {
      if (window.AppMapa?.aplicarEstadoDoObjeto) {
        window.AppMapa.aplicarEstadoDoObjeto(payload.dados);
        ultimoHashEstadoLocal = hashRecebido;
        mostrarToast(`Mapa atualizado por ${payload.atualizadoPor?.nome || 'um colega'}`);
      }
    } finally {
      setTimeout(() => {
        ignorandoMudancaRemota = false;
      }, 50);
    }
  });
}

function encerrarSincronizacaoProjeto() {
  if (listenerProjeto) off(ref(db, 'projeto/compartilhado'));
}

function salvarProjetoRemotoImediato() {
  if (!usuarioAtual || !conectadoAoFirebase || !window.AppMapa?.estadoParaObjeto) return;
  if (ignorandoMudancaRemota) return;

  const dados = window.AppMapa.estadoParaObjeto();
  const hash = JSON.stringify(dados);
  if (hash === ultimoHashEstadoLocal) return;

  atualizarStatusUI('salvando', 'Salvando...');
  ultimoHashEstadoLocal = hash;

  const projetoRef = ref(db, 'projeto/compartilhado');
  set(projetoRef, {
    dados,
    atualizadoPor: {
      uid: usuarioAtual.uid,
      nome: usuarioAtual.displayName || 'Usuário',
      email: usuarioAtual.email || ''
    },
    atualizadoEm: serverTimestamp()
  }).then(() => {
    atualizarStatusUI('online', 'Sincronizado');
  }).catch((err) => {
    console.error('Erro ao salvar no Firebase:', err);
    atualizarStatusUI('erro', 'Erro ao sincronizar');
  });
}

export function notificarAlteracaoLocal() {
  if (!usuarioAtual || ignorandoMudancaRemota) return;
  atualizarStatusUI('salvando', 'Sincronizando...');
  clearTimeout(debouncersSalvar);
  // Debounce de 350ms para agrupar múltiplos cliques consecutivos
  debouncersSalvar = setTimeout(() => {
    salvarProjetoRemotoImediato();
  }, 350);
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
    corUsuarioAtual = extrairCorUsuario(user.uid);

    // Atualiza interface do usuário logado
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
  forcarCarregamentoNuvem: () => {
    get(ref(db, 'projeto/compartilhado')).then((snap) => {
      if (snap.exists() && window.AppMapa?.aplicarEstadoDoObjeto) {
        window.AppMapa.aplicarEstadoDoObjeto(snap.val().dados);
        mostrarToast('Mapa recarregado da nuvem!');
      }
    });
  }
};
