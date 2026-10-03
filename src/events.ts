// The memory system lives in the narrowbit-memory package (packages/memory); this path stays so existing imports keep working.
export { forkTask } from "narrowbit-memory";
export { taskDir, ensureTaskDir, appendEvent, subscribe, readEvents, fold, type Actor, type EventType, type TokenUsage, type PlanStep, type Event, type FoldedState } from "narrowbit-memory";
