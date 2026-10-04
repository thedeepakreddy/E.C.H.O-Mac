/** Keep connected intelligence capabilities reachable despite semantic pruning. */
export function intelligenceToolNames(query: string): Set<string> {
  const q = query.toLowerCase();
  const names = new Set<string>();
  const osiris = /\bosiris\b|ఒసిరిస్|ओसिरिस/.test(q);
  const camera = /\b(cctv|webcams?|live cameras?|street cameras?|traffic cameras?)\b/.test(q);
  const layer = /\blayers?\b/.test(q);
  if (/ఉపగ్రహ|వార్త|న్యూస్|దగ్గర|సమీప|నెట్.?వర్క్|బలహీనత|उपग्रह|समाचार|खबर|नज़दीक|नजदीक|आसपास|नेटवर्क/.test(q)) names.add('open_intel');
  if (osiris && /\b(focus|zoom|pan|fly|centre|center)\b/.test(q)) names.add('osiris_focus');
  if (layer && (osiris || /\b(satellites?|military|earthquakes?|fires?|flights?|weather|cctv)\b/.test(q))) names.add('osiris_layers');
  if (osiris && /\b(open|show|map|globe|view)\b/.test(q) && !camera && !layer) names.add('show_osiris');
  if (camera || /\b(earthquakes?|quakes?|wildfires?|conflict zones?|space weather|air traffic|cyber threats|world briefing)\b/.test(q) || (osiris && !names.size)) names.add('osiris_intel');
  if (camera && /\b(show|open|watch|see)\b/.test(q)) names.add('open_url');
  if (/\b(around me|closest|near me)\b/.test(q) || /\b(pharmacy|pharmacies|hospital|atm|cafe|restaurant|supermarket|fuel|station)\b.*\b(near|around|in)\b/.test(q)) names.add('open_intel');
  if (!camera && /\b(satellites?|satilites?|iss|norad|celestrak|hubble|starlink|tiangong|news|headlines|nearby|near me|nearest|exploited|cves?|kev|cisa|bgp|asn|whois|who owns|network ownership)\b/.test(q)) names.add('open_intel');
  if (/\bAS\d+\b/i.test(q) || /\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(q)) names.add('open_intel');
  return names;
}

export const INTELLIGENCE_TOOL_GUIDANCE =
  'For live satellite positions/passes, topic news, nearby places, IP/ASN ownership or known exploited CVEs, use open_intel with source satellites/news/nearby/network/exploited. ' +
  'For Osiris grid data and cameras use osiris_intel; open the globe only when asked to show the map. ' +
  'Use returned evidence instead of inventing current facts. Feed errors mean unavailable, not no events. ' +
  'For precise nearby answers ask for a place/coordinates if unknown; a timezone city is an estimate. KEV absence does not prove a CVE safe.';
