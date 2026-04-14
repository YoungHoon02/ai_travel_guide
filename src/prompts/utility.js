/**
 * Utility prompts — small one-off LLM calls that don't belong to the main
 * planning or realtime flows.
 */

/** Globe dart — reverse geocode + humorous description for random coordinates */
export const GLOBE_GEOGRAPHY_PROMPT = `You are a geography expert. Given coordinates, identify the location. If it's ocean/desert/uninhabitable, say so humorously. Output JSON: {"label": "도시, 국가 or funny description in Korean", "emoji": "relevant emoji"}`;
