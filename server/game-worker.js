/**
 * GAME WORKER - HILO DE JUEGO INDEPENDIENTE
 * Cada partida corre en su propio Worker Thread.
 * El estado de una partida NUNCA afecta a otra.
 * Si una partida crashea, las demás siguen funcionando.
 * Cada worker tiene su propio heap de memoria (V8 isolate).
 * Comunicación con el hilo principal via parentPort.postMessage()
 *
 * ARQUITECTURA DE COMUNICACIÓN:
 *   Servidor principal  ←→  Worker Thread  ←→  (estado del juego)
 *   Los WebSockets viven en el servidor principal; el worker
 *   solo maneja lógica y le dice al servidor qué enviar a quién.
 */

const { parentPort, workerData } = require('worker_threads');
const { POKEMONS, PREGUNTAS } = require('./pokemon-data');

// ESTADO INTERNO DEL JUEGO (aislado en este hilo)

/**
 * El tablero se selecciona aleatoriamente al inicio.
 * Se eligen N pokémons del pool total → mismo tablero para ambos jugadores.
 * BOARD_SIZE define cuántos personajes aparecen en el tablero.
 */
const BOARD_SIZE = 20;

function crearTablero() {
  // Fisher-Yates shuffle para selección aleatoria sin repetición
  const copia = [...POKEMONS];
  for (let i = copia.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia.slice(0, BOARD_SIZE);
}

const tablero = crearTablero();

/**
 * Los personajes secretos deben ser DIFERENTES entre jugadores.
 * Seleccionamos dos índices distintos del tablero al azar.
 */
function asignarSecretos() {
  const idx1 = Math.floor(Math.random() * tablero.length);
  let idx2;
  do {
    idx2 = Math.floor(Math.random() * tablero.length);
  } while (idx2 === idx1);
  return [tablero[idx1], tablero[idx2]];
}

const [secretoJ1, secretoJ2] = asignarSecretos();

// workerData contiene los IDs de los dos jugadores (pasados al crear el worker)
const { jugador1Id, jugador2Id, gameId } = workerData;

/**
 * Estado completo del juego.
 * Toda la lógica vive AQUÍ, en el servidor (worker).
 * El cliente NUNCA conoce el personaje secreto del oponente.
 * El cliente NUNCA puede manipular el estado directamente.
 */
const estado = {
  gameId,
  turno: jugador1Id,
  fase: 'jugando',
  ganador: null,
  tablero,
  jugadores: {
    [jugador1Id]: {
      id: jugador1Id,
      numero: 1,
      secreto: secretoJ1,
      eliminados: new Set(),
    },
    [jugador2Id]: {
      id: jugador2Id,
      numero: 2,
      secreto: secretoJ2,
      eliminados: new Set(),
    }
  }
};

// HELPERS

function oponenteDe(jugadorId) {
  return jugadorId === jugador1Id ? jugador2Id : jugador1Id;
}

/** Envía mensaje al servidor principal para que lo reenvíe al cliente */
function enviarAlJugador(jugadorId, mensaje) {
  parentPort.postMessage({
    tipo: 'ENVIAR_A_JUGADOR',
    jugadorId,
    datos: mensaje
  });
}

/** Envía a ambos jugadores */
function broadcast(mensaje) {
  enviarAlJugador(jugador1Id, mensaje);
  enviarAlJugador(jugador2Id, mensaje);
}

// INICIO DEL JUEGO

/**
 * Al iniciar, enviamos a cada jugador:
 * 1. El tablero completo (mismo para ambos)
 * 2. Su personaje secreto PRIVADO (solo él lo ve)
 * 3. De quién es el turno inicial
 *
 * Nunca enviamos el secreto del oponente.
 * El servidor es la única fuente de verdad.
 */
function iniciarJuego() {
  // Tablero serializable (sin Sets que no se pueden pasar por postMessage)
  const tableroData = tablero.map(p => ({
    id: p.id,
    name: p.name,
    img: p.img,
  }));

  [jugador1Id, jugador2Id].forEach(jId => {
    const jugador = estado.jugadores[jId];
    enviarAlJugador(jId, {
      tipo: 'JUEGO_INICIADO',
      gameId,
      tablero: tableroData,
      tuSecreto: {
        id: jugador.secreto.id,
        name: jugador.secreto.name,
        img: jugador.secreto.img,
      },
      turnoActual: estado.turno,
      tuId: jId,
      preguntas: PREGUNTAS,
    });
  });

  console.log(`[Game ${gameId}] Iniciado. J1=${jugador1Id} secreto=${secretoJ1.name} | J2=${jugador2Id} secreto=${secretoJ2.name}`);
}

// LÓGICA DE ACCIONES

/**
 * El jugador elige una pregunta del catálogo.
 * El servidor evalúa la respuesta contra el secreto del OPONENTE.
 * La pregunta se hace sobre el personaje del oponente.
 * Retorna SI o NO. El cliente decide qué cartas eliminar visualmente.
 */
function procesarPregunta(jugadorId, preguntaId) {
  if (estado.fase !== 'jugando') return;
  if (estado.turno !== jugadorId) {
    enviarAlJugador(jugadorId, { tipo: 'ERROR', mensaje: 'No es tu turno.' });
    return;
  }

  const pregunta = PREGUNTAS.find(p => p.id === preguntaId);
  if (!pregunta) {
    enviarAlJugador(jugadorId, { tipo: 'ERROR', mensaje: 'Pregunta inválida.' });
    return;
  }

  const oponenteId = oponenteDe(jugadorId);
  const secretoOponente = estado.jugadores[oponenteId].secreto;
  const respuesta = secretoOponente[preguntaId] === true ? 'SI' : 'NO';

  console.log(`[Game ${gameId}] J${estado.jugadores[jugadorId].numero} pregunta: "${pregunta.texto}" → ${respuesta} (secreto oponente: ${secretoOponente.name})`);

  // Notificamos a ambos jugadores sobre la pregunta y respuesta
  broadcast({
    tipo: 'RESULTADO_PREGUNTA',
    preguntaTexto: pregunta.texto,
    preguntaId: pregunta.id,
    respuesta,
    jugadorQuePreguntoId: jugadorId,
    turnoActual: oponenteId,
  });

  // Cambiar turno
  estado.turno = oponenteId;
}

/**
 * ADIVINANZA
 * El jugador intenta adivinar quién es el personaje del oponente.
 * Si acierta → gana. Si falla → pierde inmediatamente.
 */
function procesarAdivinanza(jugadorId, pokemonId) {
  if (estado.fase !== 'jugando') return;
  if (estado.turno !== jugadorId) {
    enviarAlJugador(jugadorId, { tipo: 'ERROR', mensaje: 'No es tu turno.' });
    return;
  }

  const oponenteId = oponenteDe(jugadorId);
  const secretoOponente = estado.jugadores[oponenteId].secreto;
  const pokemonAdivinado = tablero.find(p => p.id === pokemonId);

  if (!pokemonAdivinado) {
    enviarAlJugador(jugadorId, { tipo: 'ERROR', mensaje: 'Pokémon inválido.' });
    return;
  }

  const acerto = pokemonId === secretoOponente.id;

  console.log(`[Game ${gameId}] J${estado.jugadores[jugadorId].numero} adivina: ${pokemonAdivinado.name} | Secreto: ${secretoOponente.name} → ${acerto ? 'CORRECTO' : 'INCORRECTO'}`);

  estado.fase = 'terminado';
  estado.ganador = acerto ? jugadorId : oponenteId;

  // Revelamos ambos secretos al terminar
  broadcast({
    tipo: 'JUEGO_TERMINADO',
    ganadorId: estado.ganador,
    secretoJ1: { id: secretoJ1.id, name: secretoJ1.name, img: secretoJ1.img },
    secretoJ2: { id: secretoJ2.id, name: secretoJ2.name, img: secretoJ2.img },
    jugador1Id,
    jugador2Id,
    intentoFallido: !acerto ? {
      jugadorId,
      pokemonIntentado: pokemonAdivinado.name,
      pokemonReal: secretoOponente.name,
    } : null,
    mensaje: acerto
      ? `¡Correcto! ${pokemonAdivinado.name} era el personaje secreto del oponente.`
      : `¡Incorrecto! ${pokemonAdivinado.name} no era el secreto. Era ${secretoOponente.name}. El oponente gana.`,
  });

  // Notificar al hilo principal que el juego terminó (para limpiar recursos)
  parentPort.postMessage({ tipo: 'JUEGO_TERMINADO', gameId });
}

// MANEJO DE DESCONEXIONES

function procesarDesconexion(jugadorId) {
  if (estado.fase === 'terminado') return;

  estado.fase = 'terminado';
  const oponenteId = oponenteDe(jugadorId);

  broadcast({
    tipo: 'JUGADOR_DESCONECTADO',
    mensaje: 'Un jugador se desconectó. La partida ha terminado.',
    ganadorId: oponenteId,
  });

  parentPort.postMessage({ tipo: 'JUEGO_TERMINADO', gameId });
}

// RECEPTOR DE MENSAJES DEL SERVIDOR PRINCIPAL

/**
 * El worker recibe mensajes del servidor principal
 * via parentPort.on('message'). Este es el único canal de entrada.
 * Toda acción del cliente pasa por: Cliente → WebSocket → Servidor → Worker
 */
parentPort.on('message', (mensaje) => {
  const { tipo, jugadorId, datos } = mensaje;

  switch (tipo) {
    case 'INICIAR':
      iniciarJuego();
      break;

    case 'ACCION':
      if (datos.accion === 'PREGUNTA') {
        procesarPregunta(jugadorId, datos.preguntaId);
      } else if (datos.accion === 'ADIVINAR') {
        procesarAdivinanza(jugadorId, datos.pokemonId);
      }
      break;

    case 'DESCONEXION':
      procesarDesconexion(jugadorId);
      break;

    default:
      console.warn(`[Game ${gameId}] Mensaje desconocido: ${tipo}`);
  }
});
