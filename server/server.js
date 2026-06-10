/**
SERVIDOR PRINCIPAL - ADIVINA QUIÉN POKÉMON
 * 1. WebSockets (librería 'ws'):
 *    - Más apropiado que TCP puro para clientes web (browsers no tienen acceso a sockets TCP raw)
 *    - Bidireccional y basado en eventos, ideal para juegos en tiempo real
 *    - ws es la librería WebSocket más popular y eficiente para Node.js
 *
 * 2. Worker Threads (módulo nativo 'worker_threads'):
 *    - Cada partida corre en un hilo independiente del SO
 *    - Aislamiento de memoria: un crash en una partida no afecta otras
 *    - Comunicación via mensajes (no memoria compartida) → thread-safe por diseño
 *    - Node.js es single-threaded para I/O, pero worker_threads sí son hilos reales
 *
 * 3. HTTP básico para servir el cliente:
 *    - El mismo servidor sirve los archivos HTML/CSS/JS del cliente
 *    - No se requiere un servidor web separado (Nginx, Apache, etc.)
 *
 * FLUJO COMPLETO:
 *   Cliente abre página web → Servidor HTTP sirve index.html
 *   Cliente abre WebSocket → onConnection()
 *   Si hay otro esperando → crearPartida() → new Worker(game-worker.js)
 *   Worker notifica eventos → servidor reenvía al WebSocket del cliente correcto
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Worker } = require('worker_threads');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3000;

// ESTADO GLOBAL DEL SERVIDOR

/**
 * DECISIÓN: El servidor mantiene dos estructuras de datos críticas:
 *
 * 1. esperandoConexion: el jugador que llegó primero y espera pareja
 *    Es un objeto { id, ws } o null si no hay nadie esperando.
 *
 * 2. partidas: Map<gameId, { worker, jugadores: Map<jugadorId, ws> }>
 *    Almacena todas las partidas activas. Cada entrada tiene:
 *    - El Worker Thread de esa partida
 *    - Los WebSockets de los dos jugadores
 *
 * IMPORTANTE: Los WebSockets se guardan aquí en el servidor principal
 * porque los Workers no pueden acceder directamente a objetos del hilo principal.
 */

let esperandoConexion = null;
const partidas = new Map(); // gameId → { worker, jugadores: Map }

// SERVIDOR HTTP (sirve archivos del cliente)

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
};

const httpServer = http.createServer((req, res) => {
  // Rutas seguras: solo servimos archivos del directorio 'client'
  let filePath = path.join(__dirname, '../client', req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
    res.end(data);
  });
});

// SERVIDOR WEBSOCKET

/**
 * Montamos el WebSocket sobre el mismo servidor HTTP.
 * Esto permite que todo corra en el puerto 3000 sin configuración adicional.
 * El handshake HTTP del WebSocket es manejado automáticamente por la librería 'ws'.
 */
const wss = new WebSocketServer({ server: httpServer });

// Helper para enviar JSON por un WebSocket de forma segura
function enviar(ws, datos) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(datos));
  }
}

// CREACIÓN DE PARTIDAS

/**
 * Crea una nueva partida cuando hay dos jugadores disponibles.
 *
 * DECISIÓN CLAVE: new Worker() lanza un hilo real del SO.
 * Le pasamos workerData: los IDs de los jugadores y el ID de la partida.
 * Este objeto se clona (no comparte memoria) al worker → seguro.
 *
 * Luego configuramos el canal de mensajes worker → servidor
 * para reenviar mensajes a los WebSockets correctos.
 */
function crearPartida(jugador1, jugador2) {
  const gameId = uuidv4().slice(0, 8).toUpperCase();

  console.log(`\n[Servidor] ⚡ Nueva partida: ${gameId}`);
  console.log(`  Jugador 1: ${jugador1.id}`);
  console.log(`  Jugador 2: ${jugador2.id}`);

  // Notificar a ambos que están emparejados (antes de lanzar el worker)
  enviar(jugador1.ws, { tipo: 'EMPAREJADO', mensaje: 'Oponente encontrado. Iniciando partida...' });
  enviar(jugador2.ws, { tipo: 'EMPAREJADO', mensaje: 'Oponente encontrado. Iniciando partida...' });

  // Crear el Worker Thread con los datos de la partida
  const worker = new Worker(
    path.join(__dirname, 'game-worker.js'),
    {
      workerData: {
        jugador1Id: jugador1.id,
        jugador2Id: jugador2.id,
        gameId,
      }
    }
  );

  // Registrar la partida en el mapa global
  const jugadoresMap = new Map([
    [jugador1.id, jugador1.ws],
    [jugador2.id, jugador2.ws],
  ]);

  partidas.set(gameId, { worker, jugadores: jugadoresMap });

  // CANAL DE MENSAJES: Worker → Servidor → Cliente

  /**
   * DECISIÓN: El worker envía mensajes estructurados con tipo.
   * El servidor actúa como "router": recibe del worker y reenvía al WS correcto.
   *
   * Esto separa responsabilidades:
   * - Worker: solo lógica de juego
   * - Servidor: solo enrutamiento de mensajes
   */
  worker.on('message', (mensaje) => {
    if (mensaje.tipo === 'ENVIAR_A_JUGADOR') {
      const ws = jugadoresMap.get(mensaje.jugadorId);
      if (ws) enviar(ws, mensaje.datos);

    } else if (mensaje.tipo === 'JUEGO_TERMINADO') {
      // Limpiar la partida del mapa después de un breve delay
      // (para que los mensajes finales lleguen antes de limpiar)
      setTimeout(() => {
        partidas.delete(gameId);
        worker.terminate();
        console.log(`[Servidor] Partida ${gameId} finalizada y limpiada.`);
        console.log(`[Servidor] Partidas activas: ${partidas.size}`);
      }, 5000);
    }
  });

  worker.on('error', (err) => {
    console.error(`[Game ${gameId}] Error en worker:`, err);
    // Notificar a los jugadores del error
    jugadoresMap.forEach(ws => {
      enviar(ws, { tipo: 'ERROR', mensaje: 'Error interno del juego. La partida ha terminado.' });
    });
    partidas.delete(gameId);
  });

  // Iniciar el juego enviando mensaje al worker
  worker.postMessage({ tipo: 'INICIAR' });

  return gameId;
}

// MANEJO DE CONEXIONES WEBSOCKET

wss.on('connection', (ws) => {
  /**
   * Cada cliente recibe un UUID único al conectarse.
   * Este ID se usa en todo el sistema para identificar al jugador.
   */
  const jugadorId = uuidv4();
  let gameId = null; // Se asigna cuando se crea una partida

  console.log(`[Servidor] Nuevo cliente: ${jugadorId}`);

  // Confirmar conexión al cliente
  enviar(ws, {
    tipo: 'CONECTADO',
    tuId: jugadorId,
    mensaje: 'Conectado al servidor. Buscando oponente...',
  });

  // EMPAREJAMIENTO

  /**
   * Sistema de emparejamiento simple por orden de llegada.
   * El primer jugador queda en "sala de espera" (esperandoConexion).
   * El segundo desencadena la creación de una partida.
   */
  if (esperandoConexion === null) {
    // Primer jugador: poner en espera
    esperandoConexion = { id: jugadorId, ws };
    enviar(ws, {
      tipo: 'EN_ESPERA',
      mensaje: 'Esperando a otro jugador...',
    });
    console.log(`[Servidor] Jugador ${jugadorId} en espera...`);

  } else {
    // Segundo jugador: crear partida con el que estaba esperando
    const jugador1 = esperandoConexion;
    esperandoConexion = null; // Limpiar sala de espera

    const jugador2 = { id: jugadorId, ws };
    gameId = crearPartida(jugador1, jugador2);

    // Asociar el gameId al jugador 1 también
    // Nota: el jugador1.ws no tiene acceso a gameId aquí,
    // pero el worker ya sabe a qué websocket enviar por el jugadorId
    jugador1.gameId = gameId;
    jugador2.gameId = gameId;

  }

  // MENSAJES DEL CLIENTE → SERVIDOR → WORKER

  ws.on('message', (rawData) => {
    let mensaje;
    try {
      mensaje = JSON.parse(rawData);
    } catch {
      enviar(ws, { tipo: 'ERROR', mensaje: 'Formato de mensaje inválido.' });
      return;
    }

    /**
     * El cliente envía su jugadorId en cada mensaje.
     * El servidor busca en cuál partida está ese jugador
     * y reenvía la acción al worker correspondiente.
     *
     * Esto permite que el servidor maneje múltiples partidas:
     * cada mensaje se enruta al worker correcto.
     */
    if (mensaje.tipo === 'ACCION') {
      // Buscar en qué partida está este jugador
      let partidaEncontrada = null;
      for (const [gId, partida] of partidas) {
        if (partida.jugadores.has(jugadorId)) {
          partidaEncontrada = { gId, partida };
          break;
        }
      }

      if (!partidaEncontrada) {
        enviar(ws, { tipo: 'ERROR', mensaje: 'No estás en ninguna partida activa.' });
        return;
      }

      console.log(`[Servidor] Acción de ${jugadorId} en partida ${partidaEncontrada.gId}: ${JSON.stringify(mensaje.datos)}`);

      // Reenviar al worker de la partida correspondiente
      partidaEncontrada.partida.worker.postMessage({
        tipo: 'ACCION',
        jugadorId,
        datos: mensaje.datos,
      });
    }
  });

  // DESCONEXIÓN

  ws.on('close', () => {
    console.log(`[Servidor] Desconectado: ${jugadorId}`);

    // Si estaba en sala de espera, liberar el slot
    if (esperandoConexion && esperandoConexion.id === jugadorId) {
      esperandoConexion = null;
      console.log('[Servidor] Sala de espera liberada.');
      return;
    }

    // Si estaba en una partida activa, notificar al worker
    for (const [gId, partida] of partidas) {
      if (partida.jugadores.has(jugadorId)) {
        partida.worker.postMessage({
          tipo: 'DESCONEXION',
          jugadorId,
        });
        break;
      }
    }
  });

  ws.on('error', (err) => {
    console.error(`[WebSocket ${jugadorId}] Error:`, err.message);
  });
});

// INICIAR SERVIDOR

httpServer.listen(PORT, () => {
  console.log('╔════════════════════════════════════════╗');
  console.log(`║  HTTP + WebSocket en puerto ${PORT}       ║`);
  console.log(`║  Cliente: http://localhost:${PORT}        ║`);
  console.log('╚════════════════════════════════════════╝');
});
