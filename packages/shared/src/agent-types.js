export const AGENT_RUN_STATUSES = {
  IDLE: "idle",
  RUNNING: "running",
  STOPPING: "stopping",
  STOPPED: "stopped",
  ERROR: "error"
};

export const AGENT_INTERFACE_DOC = {
  detect: "detect(): Promise<boolean>",
  buildCommand: "buildCommand(context): { command, args, env, cwd }",
  buildPrompt: "buildPrompt(context): string",
  start: "start(context): AgentRunHandle",
  stop: "stop(handle): Promise<void>",
  health: "health(handle): { status }"
};
