/**
 * Realtime / Live Co-Pilot prompts — used during the trip when the user is
 * actively following a plan and needs it to adapt to変수 상황 (weather,
 * oversleep, closures, etc.).
 */

/**
 * Real-time travel co-pilot system prompt — used in VariableHandlerPanel.
 * Injects current plan/time/location/weather/progress/directions context.
 *
 * @param {{plan: Array, currentTime: string, location: string|null, weather: object|null, progress: {done: Array, remaining: Array}, directions: Array|null}} ctx
 * @returns {string}
 */
export function buildRealtimeSystemPrompt({ plan, currentTime, location, weather, progress, directions }) {
  const planText = plan
    .map((item) => `DAY${item.assignedDay} ${item.time} [${item.area}] ${item.name} (${item.type}) stayScore:${item.visitScore} ${item.indoor ? "indoor" : "outdoor"}`)
    .join("\n");
  const doneNames = progress.done.map((i) => i.name).join(", ") || "none";
  const remainNames = progress.remaining.map((i) => i.name).join(", ") || "none";
  const dirText = directions && directions.length > 0
    ? "\nRoute info (Google Maps Directions):\n" + directions.map((d) => `  ${d.fromName} → ${d.toName}: ${d.duration ?? "?"} / ${d.distance ?? "?"}`).join("\n")
    : "";
  return `You are an AI travel co-pilot managing the user's Tokyo 2-night 3-day itinerary in real time.

## Current context
- Current time: ${currentTime}
- Current location: ${location ?? "unknown"}
- Weather: ${weather ? `${weather.icon} ${weather.description} temp ${weather.temp} humidity ${weather.humidity} wind ${weather.wind}` : "unavailable"}
- Completed items: ${doneNames}
- Remaining items: ${remainNames}${dirText}

## Full trip plan
${planText}

## Task
When the user reports a contingency (oversleep, weather change, cancellation, long queue, etc.):
1. Analyze the situation concisely.
2. Identify which itinerary items are affected.
3. Propose a revised itinerary, and ALWAYS include the following JSON block at the end of your response:
\`\`\`json
{"modifiedSchedule":[{"id":"...","name":"...","time":"HH:MM","assignedDay":1,"area":"...","type":"...","visitScore":0},...]}
\`\`\`
If no revision is needed, output \`{"modifiedSchedule":null}\` instead.
If more information is required, ask a clarifying follow-up question.

## Output language
**All user-facing text must be written in KOREAN.** These instructions are in English so the model follows them more precisely, but everything the user reads (analysis, proposal, follow-up questions) must be in Korean.`;
}
