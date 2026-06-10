# 🎮 Adivina Quién Pokémon
### Proyecto educativo de Hilos y Sockets en Node.js

---

## 📐 Arquitectura del Sistema

```
┌─────────────────────────────────────────────────────────┐
│                    CLIENTE (Browser)                     │
│  HTML + CSS + JavaScript                                 │
│  • WebSocket API nativa del browser                      │
│  • Solo maneja UI, NUNCA lógica de juego                │
└──────────────────────┬──────────────────────────────────┘
                       │  WebSocket (ws://)
                       │  JSON Messages
┌──────────────────────▼──────────────────────────────────┐
│              SERVIDOR PRINCIPAL (server.js)              │
│  Node.js - Hilo Principal (Event Loop)                  │
│                                                          │
│  ┌─────────────┐    ┌──────────────────────────────┐   │
│  │ HTTP Server │    │    WebSocket Server (ws)      │   │
│  │ (archivos   │    │                               │   │
│  │  cliente)   │    │  Sala de Espera: jugador?     │   │
│  └─────────────┘    │  partidas: Map<id, Worker>    │   │
│                     └──────────┬─────────────────────┘  │
│                                │  worker_threads          │
│              ┌─────────────────┼─────────────────┐       │
│              │                 │                 │       │
│   ┌──────────▼───┐  ┌──────────▼───┐  ┌─────────▼──┐   │
│   │  Worker #1   │  │  Worker #2   │  │  Worker #N  │   │
│   │  Partida A   │  │  Partida B   │  │  Partida N  │   │
│   │              │  │              │  │             │   │
│   │ Estado juego │  │ Estado juego │  │ Estado juego│   │
│   │ Lógica turnos│  │ Lógica turnos│  │ ...         │   │
│   │ Validaciones │  │ Validaciones │  │             │   │
│   └──────────────┘  └──────────────┘  └─────────────┘   │
└─────────────────────────────────────────────────────────┘
```

---

## 🧵 Concepto de Hilos (Worker Threads)

### ¿Qué es un hilo en este contexto?
Un **Worker Thread** en Node.js es un hilo real del sistema operativo que corre código JavaScript de forma independiente al hilo principal.

### ¿Por qué un Worker por partida?
| Sin Workers (single thread) | Con Workers (multi-thread) |
|---|---|
| Todas las partidas comparten memoria | Cada partida tiene su propio heap |
| Un error afecta todo el servidor | Un crash solo mata esa partida |
| Procesar una partida bloquea las demás | Ejecución paralela real |
| Estado compartido → race conditions | Sin memoria compartida → thread-safe |

### Comunicación entre hilos
```
Hilo Principal                    Worker Thread
     │                                  │
     │── postMessage({tipo:'INICIAR'}) ─►│
     │                                  │── iniciarJuego()
     │◄── postMessage({tipo:'ENVIAR_A_JUGADOR', datos}) ──│
     │── ws.send(datos al cliente) ──►  │
```

---

## 🔌 Concepto de Sockets (WebSockets)

### ¿Qué es un WebSocket?
Un canal de comunicación **bidireccional y persistente** entre cliente y servidor. A diferencia de HTTP que es petición-respuesta, el WebSocket permite que el servidor envíe mensajes **sin que el cliente los solicite**.

### Flujo de conexión
```
Browser                          Servidor Node.js
   │                                    │
   │── HTTP GET (Upgrade: websocket) ──►│
   │◄── 101 Switching Protocols ────────│
   │══════════ WebSocket Abierto ═══════│ ← Canal permanente
   │                                    │
   │── {"tipo":"ACCION", ...} ─────────►│ ← Cliente envía
   │◄── {"tipo":"RESULTADO", ...} ───────│ ← Servidor responde
   │◄── {"tipo":"RESULTADO", ...} ───────│ ← O notifica espontáneamente
```

### ¿Por qué WebSocket y no TCP puro?
- Los browsers **no pueden** abrir sockets TCP directamente
- WebSocket corre sobre HTTP (compatible con firewalls)
- La librería `ws` para Node.js es de bajo nivel y eficiente

---

## 🎯 Protocolo de Mensajes

### Cliente → Servidor
```json
{ "tipo": "ACCION", "datos": { "accion": "PREGUNTA", "preguntaId": "esAgua" } }
{ "tipo": "ACCION", "datos": { "accion": "ADIVINAR", "pokemonId": 25 } }
```

### Servidor → Cliente
```json
{ "tipo": "CONECTADO", "tuId": "uuid-v4" }
{ "tipo": "EN_ESPERA", "mensaje": "..." }
{ "tipo": "EMPAREJADO", "mensaje": "..." }
{ "tipo": "JUEGO_INICIADO", "tablero": [...], "tuSecreto": {...}, "preguntas": [...] }
{ "tipo": "RESULTADO_PREGUNTA", "preguntaTexto": "...", "respuesta": "SI|NO", "turnoActual": "..." }
{ "tipo": "JUEGO_TERMINADO", "ganadorId": "...", "secretoJ1": {...}, "secretoJ2": {...} }
```

---

## 🚀 Cómo Ejecutar

### 1. Instalar dependencias
```bash
npm install
```

### 2. Iniciar el servidor
```bash
node server/server.js
```

### 3. Abrir dos pestañas del navegador
```
http://localhost:3000
```
Abre la URL en **dos pestañas o ventanas diferentes**. La primera queda en espera, la segunda inicia la partida.

---

## 📁 Estructura de Archivos

```
guess-who/
├── server/
│   ├── server.js          ← Servidor principal (HTTP + WebSocket + Matchmaking)
│   ├── game-worker.js     ← Worker Thread (lógica de juego aislada)
│   └── pokemon-data.js    ← Datos y preguntas de los Pokémon
├── client/
│   ├── index.html         ← Interfaz del juego
│   ├── style.css          ← Estilos visuales
│   └── game.js            ← Lógica de cliente (WebSocket + UI)
├── package.json
└── README.md
```

---

## 🔐 Principios de Seguridad Implementados

1. **Todo el estado en el servidor**: El cliente nunca conoce el secreto del oponente
2. **Validación de turno**: El servidor rechaza acciones fuera de turno
3. **Validación de partida**: El servidor verifica que el jugador pertenezca a la partida
4. **Aislamiento de partidas**: Los Workers no comparten memoria entre sí

---

## 🃏 Agregar tus propias imágenes de Pokémon

1. Coloca tus imágenes en `client/img/`
2. En `server/pokemon-data.js`, cambia la propiedad `img` de cada Pokémon:
   ```javascript
   img: "/img/pikachu.png"  // Imagen local
   // En vez de:
   img: "https://raw.githubusercontent.com/PokeAPI/..."  // URL externa
   ```
