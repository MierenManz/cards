const name = prompt(
  "What is your username",
  Math.random().toString(36).substring(2, 9),
);

// Hacky but it works
const gameID = document.location.pathname.split("/").pop();
const ws = new WebSocket(`ws://${document.location.host}/game/${gameID}/`);

ws.onopen = console.log;
ws.onclose = console.log; // Possibly Add this to chat?
ws.onmessage = messageHandler;

function messageHandler(evt) {
}