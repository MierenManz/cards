import { Player, Spectator } from "./clients.ts";
import { GameState } from "./game_state.ts";
import { isValidPayload } from "./validate_payload.ts";
import { cardCache } from "../cards/cards_cache.ts";

import type { AnyClientEvent } from "../../types/client_send_payloads/mod.ts";
import type {
  AnyServerEvent,
  MiscEvents,
} from "../../types/server_send_payloads/mod.ts";

const INVALID_PAYLOAD: MiscEvents.ServerError = {
  type: "error",
  error: "Invalid payload",
  message: "Payload that was send is invalid",
};

const INVALID_CARD_INDEX: MiscEvents.ServerError = {
  type: "error",
  error: "Invalid card index",
  message: "Card could not be found",
};

const NOT_YOUR_TURN: MiscEvents.ServerError = {
  type: "error",
  error: "Illegal actions",
  message: "Tried to use a move while it is not your turn",
};

const NON_TURN_BASED_EVENTS = ["chat_message", "disconnect"];

/**
 * Resources that need to be managed
 *
 * Websocket connections of players (done by `Player` and `Spectator` classes)
 *
 * Timeout for lobby (done by `this.cleanUp`)
 *
 * AbortController eventListeners (done by `Player`, `Spectator` classes and `this.cleanUp`)
 */
export class Game {
  public gameID: string;
  public createdAt: Date;
  public abortController: AbortController;
  public state: GameState;
  public playercount: number;

  private spectators: Spectator[];
  private players: Player[];
  private timeoutID: number;

  constructor(gameID: string) {
    this.gameID = gameID;
    this.createdAt = new Date();
    this.abortController = new AbortController();
    this.state = new GameState();
    this.playercount = 0;
    this.spectators = [];
    this.players = [];

    this.abortController
      .signal
      .addEventListener("abort", () => this.cleanUp(), { once: true });

    this.timeoutID = setTimeout(() => {
      if (this.players.length < 2) this.cancelGame();
      this.timeoutID = NaN;
    }, 1000 * 60 * 2);
  }

  startGame(): void {
    clearTimeout(this.timeoutID);
    this.sendGlobalEvent({ type: "game_start" });
  }

  stopGame(event: MiscEvents.GameCancel): void {
    this.sendGlobalEvent(event);
    // cleanUp will handle all player connections
    this.cleanUp();
  }

  cancelGame(): void {
    this.sendGlobalEvent({
      type: "game_cancel",
      reason: "Not all players connected",
    });
  }

  sendGlobalEvent(record: AnyServerEvent): void {
    // Broadcast to players and spectators
    this.spectators
      .concat(this.players)
      .forEach((x) => x.sendEvent(record));
  }

  // Not sure if I will need this.
  sendPlayerEvent(record: AnyServerEvent): void {
    // Send only to players
    // Not intended for spectators
    for (const player of this.players) player.sendEvent(record);
  }

  addClient(websocket: WebSocket, name: string): Promise<void> {
    return this.playercount < 2
      ? this.#addPlayer(websocket, name)
      : this.#addSpectator(websocket, name);
  }

  /**
   * Works as a destructor.
   *
   * Clears up AbortController stuff
   *
   * Clears up Players and Spectators
   */
  cleanUp(): void {
    this.state.cleanUp();
    this.spectators = [];
    this.players.forEach((x) => x.cleanUp());
    this.players = [];
  }

  // Private API

  async #addPlayer(webSocket: WebSocket, name: string) {
    const player = new Player({
      gameID: this.gameID,
      id: this.players.length,
      gameAbortSignal: this.abortController.signal,
      isPlayer: true,
      webSocket,
      name,
    });

    // Initiate all eventListeners
    player.onClose(() =>
      this.stopGame({ type: "game_cancel", reason: "Player disconnected" })
    );

    player.onError(() =>
      this.stopGame({
        type: "game_cancel",
        reason: "Player connection got forcibly closed",
      })
    );

    player.onMessage(this.#gameEventHandler.bind(this));

    // Wait for the connection to be opened
    await player.awaitConnection();

    this.players.push(player);
    this.playercount += 1;
  }

  async #addSpectator(webSocket: WebSocket, name: string) {
    const possibleID = this.spectators.findIndex((x) => x === undefined);
    const spectator = new Spectator({
      gameID: this.gameID,
      // If there is a empty spot in array, grab that. Else assign new one
      id: possibleID > 0 ? possibleID : this.spectators.length,
      gameAbortSignal: this.abortController.signal,
      isPlayer: false,
      webSocket,
      name,
    });

    // Silently remove spectator from match if disconnected
    spectator.onClose(() => this.#removeSpectator(spectator));
    spectator.onError(() => this.#removeSpectator(spectator));

    // Wait for the connection to be opened
    await spectator.awaitConnection();
    this.spectators[spectator.id] = spectator;
  }

  #removeSpectator(spectator: Spectator) {
    delete this.spectators[spectator.id];
    spectator.cleanUp();
  }

  #gameEventHandler(evt: MessageEvent<string>, playerID: number): void {
    // Handle incoming events from players
    const player = this.players[playerID];

    const eventRecord: AnyClientEvent = JSON.parse(evt.data);
    // Check if it's player's turn and if the action requires a turn
    if (
      this.state.turn % 2 !== playerID &&
      !NON_TURN_BASED_EVENTS.includes(eventRecord.type)
    ) {
      return player.sendEvent(NOT_YOUR_TURN);
    }

    const opponent = this.players[playerID === 0 ? 1 : 0];

    switch (eventRecord.type) {
      case "draw_card": {
        // Validate action
        if (!isValidPayload(eventRecord, ["type"])) {
          return player.sendEvent(INVALID_PAYLOAD);
        }

        // Get card from db
        const card = cardCache.getRandomCard();

        // Add card to player deck
        const index = player.deck.addCard(card);

        // Send events
        player.sendEvent({ type: "self_draw", cardIndex: index, card });
        opponent.sendEvent({ type: "opp_draw", cardIndex: index });

        break;
      }

      case "play_card": {
        // Validate action
        if (!isValidPayload(eventRecord, ["type", "cardIndex"])) {
          return player.sendEvent(INVALID_PAYLOAD);
        }

        // Add card to `this.gameState`
        const card = player.deck.moveCard(eventRecord.cardIndex);
        if (!card) {
          return player.sendEvent(INVALID_CARD_INDEX);
        }
        const index = this
          .state.playerDecks[playerID]
          .addCard(card);

        player.sendEvent({ type: "self_play", cardIndex: index });
        opponent.sendEvent({ type: "opp_play", cardIndex: index, card });
        break;
      }

      case "attack": {
        // Validate action
        if (
          !isValidPayload(
            eventRecord,
            ["type", "attackerCardIndex", "defenderCardIndex"],
          )
        ) {
          return player.sendEvent(INVALID_PAYLOAD);
        }
        const attackIndex = eventRecord.attackerCardIndex;
        const defenderIndex = eventRecord.defenderCardIndex;
        const attacker = this
          .state.playerDecks[playerID]
          .getCard(attackIndex);

        if (!attacker) {
          return player.sendEvent(INVALID_CARD_INDEX);
        }

        // Determine damage
        const damage = attacker.attackDamage *
          (Math.random() < attacker.critChance ? attacker.critFactor : 1);

        // Safety check to avoid damaging the player too early
        if (defenderIndex === -1 && opponent.deck.length > 0) {
          // return `Invalid action`
          return player.sendEvent(INVALID_CARD_INDEX);
        }

        if (defenderIndex === -1) {
          // If not card is selected and no cards on enemy field, attack enemy `Playerhp` at 0.10x
          player.hp -= damage * 0.25;
        } else {
          // Get deck from player
          const deck = this.state.playerDecks[opponent.id];
          // Modify card in the deck
          const card = deck.modifyCard(
            defenderIndex,
            (card) => card.health -= damage,
          );

          if (!card) return player.sendEvent(INVALID_CARD_INDEX);

          player.sendEvent({
            type: "self_attack",
            attackCardIndex: attackIndex,
            defendCardIndex: defenderIndex,
            damage,
          });

          opponent.sendEvent({
            type: "opp_attack",
            attackCardIndex: attackIndex,
            defendCardIndex: defenderIndex,
            damage,
          });
        }
        break;
      }

      case "ability": {
        // Validate action
        if (
          !isValidPayload(eventRecord, [
            "type",
            "cardIndex",
            "receiver",
            "receiverIndex",
            "abilityType",
            "damage",
          ])
        ) {
          return player.sendEvent(INVALID_PAYLOAD);
        }

        const abilityName = player
          .deck
          .getCard(eventRecord.cardIndex)
          ?.abilityName;

        if (!abilityName) {
          return player.sendEvent(INVALID_CARD_INDEX);
        }
        // Either executes or queue's ability depending on it's name
        activatePlayerAbility(abilityName, player, opponent);
        break;
      }

      case "end_turn": {
        // Validate action
        if (!isValidPayload(eventRecord, ["type"])) {
          return player.sendEvent(INVALID_PAYLOAD);
        }

        // Send end turn event
        player.sendEvent({ type: "self_end_turn" });
        opponent.sendEvent({ type: "opp_end_turn" });

        // Send start turn event to opp
        player.sendEvent({ type: "opp_start_turn" });
        opponent.sendEvent({ type: "self_start_turn" });

        break;
      }

      case "disconnect": {
        // Validate action
        if (!isValidPayload(eventRecord, ["type"])) {
          return player.sendEvent(INVALID_PAYLOAD);
        }

        opponent.sendEvent({ type: "game_win" });
        // Send win to opp
        // Close all connections and clean up
        player.cleanUp();
        opponent.cleanUp();
        return;
      }

      case "chat_message": {
        // Validate action
        if (!isValidPayload(eventRecord, ["type", "message", "user"])) {
          return player.sendEvent(INVALID_PAYLOAD);
        }

        // Resend message to Opp and Self
        return this.sendGlobalEvent(eventRecord);
      }

      default:
        // If event is not valid. Return error
        return player.sendEvent({
          type: "error",
          error: "Invalid Event",
          message: `Tried to send invalid event.`,
        });
    }

    this.state.nextTurn();
  }
}

function activatePlayerAbility(
  abilityName: string,
  _player: Player,
  _opponent: Player,
): void {
  switch (abilityName) {
    // TODO: add all abilities
    // TODO: Remove default case (not needed)
    default:
      break;
  }
}
