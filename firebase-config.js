// ============================================================================
// Configuração do Firebase e exportação dos serviços (Auth e Realtime Database)
// Utiliza os módulos oficiais do Firebase SDK v10 (compatível com GitHub Pages)
// ============================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getDatabase,
  ref,
  set,
  get,
  onValue,
  onDisconnect,
  serverTimestamp,
  off,
  runTransaction
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";

export const firebaseConfig = {
  apiKey: "AIzaSyDnt1JRDfrUliSWCpnJQ01FGdQEpr3KCKQ",
  authDomain: "rotas-brasil-ced.firebaseapp.com",
  databaseURL: "https://rotas-brasil-ced-default-rtdb.firebaseio.com",
  projectId: "rotas-brasil-ced",
  storageBucket: "rotas-brasil-ced.firebasestorage.app",
  messagingSenderId: "321627315047",
  appId: "1:321627315047:web:b40d4e23d263e4574a2dc2",
  measurementId: "G-451XSCMRQ3"
};

// Inicialização dos serviços
export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);
export const googleProvider = new GoogleAuthProvider();

// Configurações do provedor Google
googleProvider.setCustomParameters({
  prompt: 'select_account'
});

export {
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  ref,
  set,
  get,
  onValue,
  onDisconnect,
  serverTimestamp,
  off,
  runTransaction
};
