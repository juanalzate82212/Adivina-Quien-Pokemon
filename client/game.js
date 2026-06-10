/**
 * CLIENTE JAVASCRIPT
 *
 * El cliente solo:
 * 1. Muestra el estado recibido del servidor
 * 2. Captura las acciones del usuario
 * 3. Envía las acciones al servidor via WebSocket
 * 4. Actualiza la UI con los eventos recibidos
 *
 * El cliente NUNCA toma decisiones de juego. Si lo hiciera,
 * un usuario podría hacer trampa modificando el JS.
 */

// ESTADO LOCAL (solo UI, no lógica de juego)

let ws = null;
let miId = null;
let esmiTurno = false;
let tableroLocal = [];
let pokemonSeleccionado = null;

// CONEXIÓN WEBSOCKET

function conectar() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}`;

  document.getElementById('connect-status').textContent = 'Conectando al servidor...';
  ws = new WebSocket(url);

  ws.onopen = () => {
    document.getElementById('connect-status').textContent = '✓ Conectado. Buscando partida...';
  };

  /**
   * MANEJADOR CENTRAL DE MENSAJES
   * Recibe todos los eventos del servidor y actualiza la UI.
   * Patrón: switch sobre el tipo de mensaje.
   */
  ws.onmessage = (event) => {
    const mensaje = JSON.parse(event.data);
    console.log('[WS Recibido]', mensaje);
    manejarMensaje(mensaje);
  };

  ws.onclose = () => {
    if (!document.getElementById('screen-gameover').classList.contains('active')) {
      mostrarError('Conexión perdida con el servidor.');
    }
  };

  ws.onerror = () => {
    mostrarError('Error de conexión. Asegúrate de que el servidor esté corriendo.');
  };
}

function manejarMensaje(msg) {
  switch (msg.tipo) {

    case 'CONECTADO':
      miId = msg.tuId;
      console.log('Mi ID:', miId);
      break;

    case 'EN_ESPERA':
      mostrarPantalla('screen-waiting');
      break;

    case 'EMPAREJADO':
      document.querySelector('#screen-waiting .status-msg').textContent = msg.mensaje;
      break;

    case 'JUEGO_INICIADO':
      inicializarJuego(msg);
      break;

    case 'RESULTADO_PREGUNTA':
      manejarResultadoPregunta(msg);
      break;

    case 'JUEGO_TERMINADO':
      manejarFinJuego(msg);
      break;

    case 'JUGADOR_DESCONECTADO':
      manejarDesconexion(msg);
      break;

    case 'ERROR':
      mostrarNotificacion(msg.mensaje, 'error');
      break;

    default:
      console.warn('Mensaje desconocido:', msg.tipo);
  }
}

// INICIALIZACIÓN DEL JUEGO

function inicializarJuego(msg) {
  const { tablero, tuSecreto, turnoActual, preguntas } = msg;

  tableroLocal = tablero;

  // Mostrar pantalla de juego
  mostrarPantalla('screen-game');

  // Mostrar mi personaje secreto en el header
  document.getElementById('my-secret-img').src = tuSecreto.img;
  document.getElementById('my-secret-name').textContent = tuSecreto.name;

  // Renderizar tablero
  renderizarTablero(tablero);

  // Llenar dropdown de preguntas
  const select = document.getElementById('pregunta-select');
  select.innerHTML = '<option value="">-- Elige una pregunta --</option>';
  preguntas.forEach(p => {
    const option = document.createElement('option');
    option.value = p.id;
    option.textContent = p.texto;
    select.appendChild(option);
  });

  // Actualizar turno
  actualizarTurno(turnoActual);

  // Log inicial
  agregarLog(`⚡ ¡La partida ha comenzado! Tu personaje secreto es: ${tuSecreto.name}`, 'log-system');
  agregarLog(`🎯 ${turnoActual === miId ? 'Eres el primero en jugar.' : 'Tu oponente comienza.'}`, 'log-system');
}

// RENDERIZADO DEL TABLERO

/**
 * El tablero se renderiza completamente en el cliente.
 * Los datos vienen del servidor (mismo para ambos jugadores).
 * El "eliminado" visual es LOCAL: el cliente tacha cartas para
 * su propio proceso de descarte, pero esto no afecta al servidor.
 * El servidor solo valida la adivinanza final.
 */
function renderizarTablero(tablero) {
  const board = document.getElementById('pokemon-board');
  board.innerHTML = '';

  tablero.forEach(pokemon => {
    const card = document.createElement('div');
    card.className = 'pokemon-card';
    card.dataset.pokemonId = pokemon.id;
    card.dataset.pokemonName = pokemon.name;
    card.innerHTML = `
      <img src="${pokemon.img}" alt="${pokemon.name}" loading="lazy">
      <p class="card-name">${pokemon.name}</p>
    `;

    /**
     * Clic en carta → dos comportamientos según contexto:
     * 1. Si la carta no está eliminada: cicla entre normal → seleccionada → eliminada
     * 2. Permite "eliminar" visualmente pokémons descartados
     * 3. Permite seleccionar uno para adivinar (si es tu turno)
     */
    card.addEventListener('click', () => manejarClicCarta(card, pokemon));
    board.appendChild(card);
  });
}

function manejarClicCarta(card, pokemon) {
  if (card.classList.contains('eliminated')) return;

  if (card.classList.contains('selected')) {
    // Deseleccionar → eliminar del tablero visual
    card.classList.remove('selected');
    card.classList.add('eliminated');
    pokemonSeleccionado = null;
    actualizarAdivinanzaUI(null);
    return;
  }

  // Deseleccionar el anterior si hay uno
  const prevSelected = document.querySelector('.pokemon-card.selected');
  if (prevSelected) prevSelected.classList.remove('selected');

  // Seleccionar este
  card.classList.add('selected');
  pokemonSeleccionado = pokemon;
  actualizarAdivinanzaUI(pokemon);
}

function actualizarAdivinanzaUI(pokemon) {
  const container = document.getElementById('adivinar-selected');
  const btnAdivinar = document.getElementById('btn-adivinar');

  if (pokemon) {
    container.innerHTML = `
      <div class="selected-display">
        <img src="${pokemon.img}" alt="${pokemon.name}">
        <span class="sel-name">${pokemon.name}</span>
      </div>
    `;
    btnAdivinar.disabled = !esmiTurno;
  } else {
    container.innerHTML = '<p class="no-selection">Haz clic en un Pokémon del tablero para seleccionar</p>';
    btnAdivinar.disabled = true;
  }
}

// GESTIÓN DE TURNOS

function actualizarTurno(turnoJugadorId) {
  esmiTurno = (turnoJugadorId === miId);

  const turnText = document.getElementById('turn-text');
  const actionsContainer = document.getElementById('actions-container');
  const waitingTurn = document.getElementById('waiting-turn');
  const btnAdivinar = document.getElementById('btn-adivinar');

  if (esmiTurno) {
    turnText.textContent = '¡TU TURNO!';
    actionsContainer.style.display = 'flex';
    waitingTurn.classList.add('hidden');
    // Reactivar botón adivinar si hay selección
    if (pokemonSeleccionado) btnAdivinar.disabled = false;
  } else {
    turnText.textContent = 'Turno del oponente';
    actionsContainer.style.display = 'none';
    waitingTurn.classList.remove('hidden');
    btnAdivinar.disabled = true;
  }
}

// ACCIONES DEL JUGADOR → SERVIDOR

/**
 * ENVÍO DE ACCIONES:
 * El cliente envía un objeto JSON con tipo 'ACCION' y los datos específicos.
 * El servidor lo recibe, lo valida, y lo reenvía al Worker Thread de la partida.
 * El resultado vuelve como un mensaje diferente (RESULTADO_PREGUNTA, etc.)
 */

function hacerPregunta() {
  const select = document.getElementById('pregunta-select');
  const preguntaId = select.value;

  if (!preguntaId) {
    mostrarNotificacion('Selecciona una pregunta primero.', 'warning');
    return;
  }
  if (!esmiTurno) return;

  // Deshabilitar controles mientras se procesa
  document.getElementById('btn-preguntar').disabled = true;

  ws.send(JSON.stringify({
    tipo: 'ACCION',
    datos: {
      accion: 'PREGUNTA',
      preguntaId: preguntaId,
    }
  }));

  select.value = '';
}

function hacerAdivinanza() {
  if (!pokemonSeleccionado || !esmiTurno) return;

  // Confirmación antes de adivinar (es una acción de alto riesgo)
  const confirmacion = confirm(
    `¿Estás seguro de que el personaje del oponente es ${pokemonSeleccionado.name}?\n\n⚠️ Si fallas, PIERDES la partida.`
  );
  if (!confirmacion) return;

  document.getElementById('btn-adivinar').disabled = true;

  ws.send(JSON.stringify({
    tipo: 'ACCION',
    datos: {
      accion: 'ADIVINAR',
      pokemonId: pokemonSeleccionado.id,
    }
  }));
}

// MANEJO DE RESPUESTAS DEL SERVIDOR

function manejarResultadoPregunta(msg) {
  const { preguntaTexto, respuesta, jugadorQuePreguntoId, turnoActual } = msg;

  const fueYo = jugadorQuePreguntoId === miId;
  const quien = fueYo ? 'Tú preguntaste' : 'El oponente preguntó';

  // Log de la pregunta
  agregarLog(`🔍 ${quien}: "${preguntaTexto}"`, 'log-question');

  // Log de la respuesta con color según SI/NO
  const claseRespuesta = respuesta === 'SI' ? 'log-answer' : 'log-answer no';
  agregarLog(`→ Respuesta: ${respuesta}`, claseRespuesta);

  // Reactivar botón de pregunta
  document.getElementById('btn-preguntar').disabled = false;

  // Actualizar turno
  actualizarTurno(turnoActual);
}

function manejarFinJuego(msg) {
  const { ganadorId, secretoJ1, secretoJ2, jugador1Id, jugador2Id, mensaje } = msg;

  const gane = ganadorId === miId;

  // Determinar mis secreto y el del oponente para la pantalla final
  const miSecreto = jugador1Id === miId ? secretoJ1 : secretoJ2;
  const secretoOponente = jugador1Id === miId ? secretoJ2 : secretoJ1;

  // Mostrar pantalla de fin de juego
  mostrarPantalla('screen-gameover');

  document.getElementById('gameover-icon').textContent = gane ? '🏆' : '💔';
  document.getElementById('gameover-title').textContent = gane ? '¡Ganaste!' : 'Perdiste';
  document.getElementById('gameover-title').style.color = gane ? 'var(--green-dark)' : 'var(--red)';
  document.getElementById('gameover-msg').textContent = mensaje;

  // Revelar secretos
  document.getElementById('reveal-my-img').src = miSecreto.img;
  document.getElementById('reveal-my-name').textContent = miSecreto.name;
  document.getElementById('reveal-opp-img').src = secretoOponente.img;
  document.getElementById('reveal-opp-name').textContent = secretoOponente.name;
}

function manejarDesconexion(msg) {
  mostrarPantalla('screen-gameover');
  document.getElementById('gameover-icon').textContent = '⚡';
  document.getElementById('gameover-title').textContent = 'Oponente desconectado';
  document.getElementById('gameover-msg').textContent = msg.mensaje;
}

// UTILIDADES DE UI

function mostrarPantalla(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function agregarLog(texto, clase = 'log-system') {
  const log = document.getElementById('game-log');
  const entry = document.createElement('p');
  entry.className = `log-entry ${clase}`;
  entry.textContent = texto;
  log.appendChild(entry);
  // Auto-scroll al último mensaje
  log.scrollTop = log.scrollHeight;
}

function mostrarNotificacion(mensaje, tipo = 'info') {
  // Notificación simple via consola y alert para no complejizar el demo
  if (tipo === 'error') {
    alert('❌ Error: ' + mensaje);
  } else if (tipo === 'warning') {
    alert('⚠️ ' + mensaje);
  }
}

function mostrarError(msg) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-connecting').classList.add('active');
  document.getElementById('connect-status').textContent = '❌ ' + msg;
  document.getElementById('connect-status').style.color = 'red';
}

// INICIO

// Iniciar conexión al cargar la página
window.addEventListener('load', () => {
  mostrarPantalla('screen-connecting');
  conectar();
});
