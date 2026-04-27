/**
 * Centralized LLM prompts — barrel file.
 *
 * Prompts are organized by domain:
 *   - planning.js  — wizard flow (destination, transport, lodging, itinerary, parser)
 *   - realtime.js  — Live Co-Pilot (in-trip schedule adaptation)
 *   - utility.js   — one-off helpers (globe geography, etc.)
 *
 * Import from here (`../prompts/index.js` or `../prompts`) to avoid worrying
 * about which domain file a prompt lives in. Or import directly from a domain
 * module when you only need one and want to minimize surface area.
 */

export {
  DEST_SYSTEM_PROMPT,
  TRANSPORT_PROMPT,
  LODGING_PROMPT,
  ITINERARY_PROMPT,
  ALTERNATIVES_PROMPT,
  buildLuckyThemePrompt,
  buildPlanParserPrompt,
} from "./planning.js";

export { buildRealtimeSystemPrompt } from "./realtime.js";

export { GLOBE_GEOGRAPHY_PROMPT } from "./utility.js";
