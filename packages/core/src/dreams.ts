import { z } from "zod";
import type {
  Agent,
  AnyContext,
  Config,
  Debugger,
  Log,
  Output,
  Subscription,
  AnyAction,
  ContextState,
  Episode,
} from "./types";
import { Logger } from "./logger";
import { createContainer } from "./container";
import { createServiceManager } from "./serviceProvider";
import { TaskRunner } from "./task";
import {
  getContextId,
  createContextState,
  getContextWorkingMemory,
  getWorkingMemoryLogs,
  saveContextWorkingMemory,
  saveContextState,
  saveContextsIndex,
  loadContextState,
  getContexts,
} from "./context";
import { createMemoryStore } from "./memory";
import { createMemory } from "./memory";
import { createVectorStore } from "./memory/base";
import { runGenerate, runGenerateResults } from "./tasks";
import { exportEpisodesAsTrainingData } from "./memory/utils";
import { LogLevel } from "./types";
import { randomUUIDv7 } from "./utils";
import { createContextStreamHandler, handleStream } from "./streaming";
import { prepareAction } from "./handlers";

export function createDreams<TContext extends AnyContext = AnyContext>(
  config: Config<TContext>
): Agent<TContext> {
  let booted = false;

  const inputSubscriptions = new Map<string, Subscription>();

  const contextIds = new Set<string>();
  const contexts = new Map<string, ContextState>();
  const contextsRunning = new Set<string>();

  const {
    inputs = {},
    outputs = {},
    events = {},
    actions = [],
    experts = {},
    services = [],
    extensions = [],
    model,
    reasoningModel,
    exportTrainingData,
    trainingDataPath,
  } = config;

  const container = config.container ?? createContainer();

  const taskRunner = config.taskRunner ?? new TaskRunner(3);

  const logger = new Logger({
    level: config.logger ?? LogLevel.INFO,
    enableTimestamp: true,
    enableColors: true,
  });

  container.instance("logger", logger);

  logger.debug("dreams", "Creating agent", {
    hasModel: !!model,
    hasReasoningModel: !!reasoningModel,
    inputsCount: Object.keys(inputs).length,
    outputsCount: Object.keys(outputs).length,
    actionsCount: actions.length,
    servicesCount: services.length,
    extensionsCount: extensions.length,
  });

  const debug: Debugger = (...args) => {
    if (!config.debugger) return;
    try {
      config.debugger(...args);
    } catch {
      console.log("debugger failed");
    }
  };

  const serviceManager = createServiceManager(container);

  for (const service of services) {
    serviceManager.register(service);
  }

  for (const extension of extensions) {
    if (extension.inputs) Object.assign(inputs, extension.inputs);
    if (extension.outputs) Object.assign(outputs, extension.outputs);
    if (extension.events) Object.assign(events, extension.events);
    if (extension.actions) actions.push(...extension.actions);
    if (extension.services) {
      for (const service of extension.services) {
        serviceManager.register(service);
      }
    }
  }

  const agent: Agent<TContext> = {
    inputs,
    outputs,
    events,
    actions,
    experts,
    memory:
      config.memory ?? createMemory(createMemoryStore(), createVectorStore()),
    container,
    model,
    reasoningModel,
    taskRunner,
    debugger: debug,
    context: config.context ?? undefined,
    exportTrainingData,
    trainingDataPath,
    emit: (event: string, data: any) => {
      logger.debug("agent:event", event, data);
    },

    async getContexts() {
      return getContexts(contextIds, contexts);
    },

    async getContext(params) {
      logger.trace("agent:getContext", "Getting context state", params);
      const id = getContextId(params.context, params.args);

      if (!contexts.has(id) && contextIds.has(id)) {
        const state = await loadContextState(agent, params.context, id);

        if (state) {
          await this.saveContext(
            await createContextState(
              agent,
              params.context,
              params.args,
              state.settings
            )
          );
        }
      }

      if (!contexts.has(id)) {
        await this.saveContext(
          await createContextState(agent, params.context, params.args)
        );
      }

      return contexts.get(id)! as ContextState<typeof params.context>;
    },

    async saveContext(ctxState, workingMemory) {
      contextIds.add(ctxState.id);
      contexts.set(ctxState.id, ctxState);

      await saveContextState(agent, ctxState);

      if (workingMemory) {
        await saveContextWorkingMemory(agent, ctxState.id, workingMemory);
      }

      await saveContextsIndex(agent, contextIds);

      return true;
    },

    getContextId(params) {
      logger.trace("agent:getContextId", "Getting context id", params);
      return getContextId(params.context, params.args);
    },

    async getWorkingMemory(contextId) {
      logger.trace("agent:getWorkingMemory", "Getting working memory", {
        contextId,
      });
      return getContextWorkingMemory(agent, contextId);
    },

    async start(args) {
      logger.info("agent:start", "Starting agent", { args, booted });
      if (booted) return agent;

      booted = true;

      logger.debug("agent:start", "Booting services");
      await serviceManager.bootAll();

      logger.debug("agent:start", "Installing extensions", {
        count: extensions.length,
      });

      for (const extension of extensions) {
        if (extension.install) await extension.install(agent);
      }

      logger.debug("agent:start", "Setting up inputs", {
        count: Object.keys(agent.inputs).length,
      });

      for (const [type, input] of Object.entries(agent.inputs)) {
        if (input.install) {
          logger.trace("agent:start", "Installing input", { type });
          await Promise.resolve(input.install(agent));
        }

        if (input.subscribe) {
          logger.trace("agent:start", "Subscribing to input", { type });
          let subscription = input.subscribe((context, args, data) => {
            logger.debug("agent", "input", { context, args, data });
            agent
              .send({
                context,
                input: { type, data },
                args,
              })
              .catch((err) => {
                logger.error("agent:input", "error", err);
              });
          }, agent);

          if (typeof subscription === "object") {
            subscription = await Promise.resolve(subscription);
          }

          if (subscription) inputSubscriptions.set(type, subscription);
        }
      }

      logger.debug("agent:start", "Setting up outputs", {
        count: Object.keys(outputs).length,
      });

      for (const [type, output] of Object.entries(outputs)) {
        if (output.install) {
          logger.trace("agent:start", "Installing output", { type });
          await Promise.resolve(output.install(agent));
        }
      }

      logger.debug("agent:start", "Setting up actions", {
        count: actions.length,
      });

      for (const action of actions) {
        if (action.install) {
          logger.trace("agent:start", "Installing action", {
            name: action.name,
          });
          await Promise.resolve(action.install(agent));
        }
      }

      logger.debug("agent:start", "Loading saved contexts");
      const savedContexts = await agent.memory.store.get<string[]>("contexts");

      if (savedContexts) {
        logger.trace("agent:start", "Restoring saved contexts", {
          count: savedContexts.length,
        });

        for (const id of savedContexts) {
          // const [type, key] = id.split(":");
          contextIds.add(id);
        }
      }

      if (agent.context) {
        logger.debug("agent:start", "Setting up agent context", {
          type: agent.context.type,
        });

        const state = await agent.getContext({
          context: agent.context,
          args: args!,
        });

        contexts.set("agent:context", state);
      }

      logger.info("agent:start", "Agent started successfully");
      return agent;
    },

    async stop() {
      logger.info("agent:stop", "Stopping agent");
    },

    async run(params) {
      const { context, args, outputs, handlers, abortSignal, model } = params;

      if (!booted) {
        logger.error("agent:run", "Agent not booted");
        throw new Error("Not booted");
      }

      logger.info("agent:run", "Running context", {
        contextType: context.type,
        hasArgs: !!args,
        hasCustomOutputs: !!outputs,
        hasHandlers: !!handlers,
      });

      const ctxState = await agent.getContext({ context, args });
      logger.debug("agent:run", "Context state retrieved", { id: ctxState.id });

      if (contextsRunning.has(ctxState.id)) {
        logger.debug("agent:run", "Context already running", {
          id: ctxState.id,
        });
        return [];
      }

      contextsRunning.add(ctxState.id);

      logger.debug("agent:run", "Added context to running set", {
        id: ctxState.id,
      });

      const workingMemory = await getContextWorkingMemory(agent, ctxState.id);

      logger.trace("agent:run", "Working memory retrieved", {
        id: ctxState.id,
        inputsCount: workingMemory.inputs.length,
        outputsCount: workingMemory.outputs.length,
        thoughtsCount: workingMemory.thoughts.length,
      });

      const contextOuputs: Output[] = Object.entries({
        ...agent.outputs,
        ...(outputs ?? {}),
      })
        .filter(([_, output]) =>
          output.enabled
            ? output.enabled({
                ...ctxState,
                context,
                workingMemory,
              })
            : true
        )
        .map(([type, output]) => ({
          type,
          ...output,
        }));

      logger.debug("agent:run", "Enabled outputs", {
        count: contextOuputs.length,
      });

      const agentCtxState = agent.context
        ? await agent.getContext({
            context: agent.context,
            args: contexts.get("agent:context")!.args,
          })
        : undefined;

      logger.debug("agent:run", "Preparing actions");

      const contextActions = await Promise.all(
        [actions, params.actions, context.actions]
          .filter((t) => !!t)
          .flat()
          .map((action: AnyAction) =>
            prepareAction({
              action,
              agent,
              agentCtxState,
              context,
              state: ctxState,
              workingMemory,
            })
          )
      ).then((r) => r.filter((a) => !!a));

      const subCtxsStates = await Promise.all(
        (params.contexts ?? []).map(async (ref) => {
          return await agent.getContext(ref);
        })
      );

      // todo: rename actions or include params/extend schema to run actions in specific context
      const subCtxsActions = await Promise.all(
        subCtxsStates
          .map((ctxState) =>
            (ctxState.context.actions ?? []).map((action: AnyAction) =>
              prepareAction({
                action,
                agent,
                agentCtxState,
                context: ctxState.context,
                state: ctxState,
                workingMemory,
              })
            )
          )
          .flat()
      ).then((r) => r.filter((a) => !!a));

      contextActions.push(...subCtxsActions);

      logger.debug("agent:run", "Enabled actions", {
        count: contextActions.length,
      });

      logger.debug("agent:run", "Agent context state", {
        hasAgentContext: !!agentCtxState,
        id: agentCtxState?.id,
      });

      const chain: Log[] = [];

      let hasError = false;
      let actionCalls: Promise<any>[] = [];

      const { state, handler, push, tags } = createContextStreamHandler({
        agent,
        chain,
        actions: contextActions,
        actionCalls,
        agentCtxState,
        ctxState,
        handlers,
        logger,
        outputs: contextOuputs,
        taskRunner,
        workingMemory,
        abortSignal,
        subCtxsStates,
      });

      if (params.chain) {
        await Promise.all(params.chain.map((log) => push(log, true)));
      }

      let step = 1;
      let maxSteps = 0;

      function getMaxSteps() {
        return ctxState.settings.maxSteps ?? 5;
      }

      while ((maxSteps = getMaxSteps()) > step) {
        logger.info("agent:run", `Starting step ${step}/${maxSteps}`, {
          contextId: ctxState.id,
        });

        try {
          const { stream } = await taskRunner.enqueueTask(
            chain.length > 0 ? runGenerateResults : runGenerate,
            {
              agent,
              model:
                model ?? context.model ?? config.reasoningModel ?? config.model,
              contexts: [agentCtxState, ctxState, ...subCtxsStates].filter(
                (t) => !!t
              ),
              contextId: ctxState.id,
              actions: contextActions,
              outputs: contextOuputs,
              workingMemory,
              logger,
              chain,
              abortSignal,
            },
            {
              debug: agent.debugger,
              abortSignal,
            }
          );

          chain.forEach((i) => {
            if (i.ref !== "input") i.processed = true;
          });

          logger.debug("agent:run", "Processing stream", { step });

          await handleStream(stream, state.index, handler, tags);

          state.index++;

          logger.debug("agent:run", "Waiting for action calls to complete", {
            pendingCalls: actionCalls.length,
          });

          await Promise.allSettled(actionCalls);

          actionCalls.length = 0;

          step++;

          if (context.onStep) {
            await context.onStep(
              {
                ...ctxState,
                workingMemory,
              },
              agent
            );
          }

          if (hasError) {
            logger.warn("agent:run", "Continuing despite error", { step });
            continue;
          }

          await agent.saveContext(ctxState);

          const pendingResults = getWorkingMemoryLogs(workingMemory).filter(
            (i) =>
              i.ref === "input" || i.ref === "thought"
                ? false
                : i.processed === false
          );

          console.log({ pendingResults });

          if (pendingResults.length === 0 || abortSignal?.aborted) break;

          await new Promise((resolve) => {
            setTimeout(resolve, 3000);
          });
        } catch (error) {
          await agent.saveContext(ctxState);

          console.error(error);

          if (context.onError) {
            try {
              context.onError(
                error,
                {
                  ...ctxState,
                  workingMemory,
                },
                agent
              );
            } catch (error) {
              break;
            }
          } else {
            break;
          }
        }
      }

      logger.debug(
        "agent:run",
        "Marking all working memory chain as processed"
      );

      chain.forEach((i) => {
        i.processed = true;
      });

      if (context.onRun) {
        await context.onRun(
          {
            ...ctxState,
            workingMemory,
          },
          agent
        );
      }

      await agent.saveContext(ctxState, workingMemory);

      logger.debug("agent:run", "Removing context from running set", {
        id: ctxState.id,
      });

      contextsRunning.delete(ctxState.id);

      logger.info("agent:run", "Run completed", {
        contextId: ctxState.id,
        chainLength: chain.length,
      });

      return chain;
    },

    async send(params) {
      logger.info("agent:send", "Sending input", {
        inputType: params.input.type,
        contextType: params.context.type,
      });

      if (params.input.type in agent.inputs === false) {
        logger.error("agent:send", "Invalid input type", {
          type: params.input.type,
        });
        throw new Error("invalid input");
      }

      const ctxSchema =
        "parse" in params.context.schema
          ? params.context.schema
          : z.object(params.context.schema);

      const args = ctxSchema.parse(params.args);

      const ctxState = await agent.getContext({
        context: params.context,
        args,
      });

      logger.debug("agent:send", "Context state retrieved", {
        id: ctxState.id,
        key: ctxState.key,
      });

      const workingMemory = await getContextWorkingMemory(agent, ctxState.id);

      logger.trace("agent:send", "Working memory retrieved", {
        id: ctxState.id,
        inputsCount: workingMemory.inputs.length,
      });

      const input = agent.inputs[params.input.type];
      const data = input.schema.parse(params.input.data);

      logger.debug("agent:send", "Input data parsed", {
        type: params.input.type,
      });

      logger.debug("agent:send", "Querying episodic memory");

      const episodicMemory = await agent.memory.vector.query(
        `${ctxState.id}`,
        JSON.stringify(data)
      );

      logger.trace("agent:send", "Episodic memory retrieved", {
        episodesCount: episodicMemory.length,
      });

      workingMemory.episodicMemory = {
        episodes: episodicMemory,
      };

      if (input.handler) {
        logger.debug("agent:send", "Using custom input handler", {
          type: params.input.type,
        });

        await input.handler(
          data,
          {
            ...ctxState,
            workingMemory,
          },
          agent
        );
      } else {
        logger.debug("agent:send", "Adding input to working memory", {
          type: params.context.type,
        });

        workingMemory.inputs.push({
          id: randomUUIDv7(),
          ref: "input",
          type: params.context.type,
          data,
          timestamp: Date.now(),
          formatted: input.format ? input.format(data) : undefined,
          processed: false,
        });
      }

      logger.debug("agent:send", "Running evaluator");

      await agent.evaluator({
        ...ctxState,
        workingMemory,
      });

      await agent.saveContext(ctxState, workingMemory);

      logger.debug("agent:send", "Running run method");
      return await agent.run(params);
    },

    async evaluator(ctx) {
      const { id, memory } = ctx;
      logger.debug("agent:evaluator", "memory", memory);
    },

    /**
     * Exports all episodes as training data
     * @param filePath Optional path to save the training data
     */
    async exportAllTrainingData(filePath?: string) {
      logger.info(
        "agent:exportTrainingData",
        "Exporting episodes as training data"
      );

      // Get all contexts
      const contexts = await agent.getContexts();

      // Collect all episodes from all contexts
      const allEpisodes: Episode[] = [];

      for (const { id } of contexts) {
        const episodes = await agent.memory.vector.query(id, "");
        if (episodes.length > 0) {
          allEpisodes.push(...episodes);
        }
      }

      logger.info(
        "agent:exportTrainingData",
        `Found ${allEpisodes.length} episodes to export`
      );

      // Export episodes as training data
      if (allEpisodes.length > 0) {
        await exportEpisodesAsTrainingData(
          allEpisodes,
          filePath || agent.trainingDataPath || "./training-data.jsonl"
        );
        logger.info(
          "agent:exportTrainingData",
          "Episodes exported successfully"
        );
      } else {
        logger.warn("agent:exportTrainingData", "No episodes found to export");
      }
    },
  };

  container.instance("agent", agent);

  return agent;
}
