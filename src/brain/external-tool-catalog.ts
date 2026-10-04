import {codingToolNames} from '../coding/tool-selection.js';
import type { McpToolHandle } from './mcp.js';
import { selectToolNames } from './tool-router.js';
import type { ToolOutput } from '../tools/registry.js';

/** Load a few external schemas now; discovery can load any remaining tool later. */
export class ExternalToolCatalog {
  readonly selected = new Set<string>();
  constructor(private readonly tools: McpToolHandle[]) {}
  async begin(query: string): Promise<void> { this.selected.clear(); if(codingToolNames(query).size && !/\b(?:gmail|inbox|github|slack|composio|perplexity|linkedin|google ?drive|calendar|osiris|satellite)\b/i.test(query))return;await this.discover(query); }
  async discover(query: string): Promise<ToolOutput> {
    const words = query.toLowerCase().replace(/inbox|email|e-mail/g, 'gmail mail email inbox').match(/[\p{L}\p{N}]{3,}/gu) ?? [];
    const ranked = this.tools.map(tool => {
      const name = tool.name.toLowerCase().replace(/_/g, ' ');
      const description = tool.description.toLowerCase().slice(0, 1200);
      return {tool, score: (query.toLowerCase().includes(tool.name.toLowerCase()) ? 1000 : 0) + words.reduce((score, word) => score + (name.includes(word) ? 4 : description.includes(word) ? 1 : 0), 0)};
    }).sort((a, b) => b.score - a.score);
    let chosen = ranked.filter(row => row.score > 0).slice(0, 8).map(row => row.tool);
    if (!chosen.length && this.tools.length) {
      const keep = await selectToolNames(query, 8, undefined, this.tools).catch(() => null);
      chosen = keep ? this.tools.filter(tool => keep.has(tool.name)).slice(0, 8) : this.tools.slice(0, 8);
    }
    for (const tool of chosen) {this.selected.delete(tool.name); this.selected.add(tool.name);}
    while (this.selected.size > 24) this.selected.delete(this.selected.values().next().value!);
    return {status: 'success', text: JSON.stringify(chosen.map(tool => ({name: tool.name, description: tool.description.slice(0, 300)})))
      + '\nThese tools are now loaded for the next request. Search again with a specific task, service, or exact tool name to load others.'};
  }
}
