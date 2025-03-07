import type { Operation } from "effection";
import { all, call, createChannel, each, resource, spawn } from "effection";

import type {
  LSPAgent,
  LSPServerRequest,
  NotificationParams,
  RequestParams,
  RPCEndpoint,
} from "./types.ts";
import { ErrorCodes } from "vscode-jsonrpc";
import type { InitializeResult } from "vscode-languageserver-protocol";
import { responseError } from "./json-rpc-connection.ts";

export interface MultiplexerOptions {
  servers: RPCEndpoint[];
}

export function useMultiplexer(
  options: MultiplexerOptions,
): Operation<RPCEndpoint> {
  return resource(function* (provide) {
    let { servers } = options;

    let notifications = createChannel<NotificationParams>();
    let requests = createChannel<LSPServerRequest>();

    for (let server of servers) {
      yield* spawn(function* () {
        for (let notification of yield* each(server.notifications)) {
          yield* notifications.send(notification);
          yield* each.next();
        }
      });

      yield* spawn(function* () {
        for (let request of yield* each(server.requests)) {
          yield* requests.send(request);
          yield* each.next();
        }
      });
    }

    let states = createChannel<State, never>();
    let state = uninitialized(servers, states.send);

    yield* spawn(function* () {
      for (state of yield* each(states)) {
        yield* each.next();
      }
    });

    let multiplexer: RPCEndpoint = {
      notifications,
      requests,
      notify: (params) => state.notify(params),
      request: (params) => state.request(params),
    };

    yield* provide(multiplexer);
  });
}

interface State {
  notify: RPCEndpoint["notify"];
  request: RPCEndpoint["request"];
}

function uninitialized(
  servers: RPCEndpoint[],
  transition: (state: State) => Operation<void>,
): State {
  return {
    *notify() {},
    *request<T>(params: RequestParams): Operation<T> {
      let [method] = params;
      if (method !== "initialize") {
        yield* responseError(
          ErrorCodes.ServerNotInitialized,
          `server not initialized`,
        );
      }
      let agents = yield* all(servers.map((server) =>
        call(function* () {
          let initialization = yield* server.request<InitializeResult>(
            params,
          );
          let { capabilities } = initialization;
          return {
            ...server,
            initialization,
            capabilities,
          } as LSPAgent;
        })
      ));

      yield* transition(initialized(agents));

      return mergecapabilities(agents) as T;
    },
  };
}

function initialized(agents: LSPAgent[]): State {
  return {
    *notify(params) {
      for (let agent of agents) {
        yield* agent.notify(params);
      }
    },
    *request(params) {
      let [method] = params;
      if (method === "initialize") {
        throw yield* responseError(
          ErrorCodes.InvalidRequest,
          `initialize invoked twice`,
        );
      }
      let [first] = agents;
      if (first) {
        return yield* first.request(params);
      } else {
        throw yield* responseError(
          ErrorCodes.InternalError,
          `no lsps to make requests`,
        );
      }
    },
  };
}

function mergecapabilities(agents: LSPAgent[]): InitializeResult {
  let [first] = agents;
  if (first) {
    return first.initialization;
  } else {
    return {
      capabilities: {},
      serverInfo: {
        name: "lspx",
        version: "0.1.0",
      },
    };
  }
}
