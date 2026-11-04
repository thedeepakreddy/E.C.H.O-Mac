import * as ax from "../tools/ax.js";
import * as vision from "../tools/vision.js";
import {NativeConsumer,consumerStatus,failureNote} from './native-consumer.js';
import type {ToolStatus} from '../memory/tool-result.js';
import type {ToolOutput} from '../tools/registry.js';

/**
 * Pulls structured data out of applications that have no API.
 *
 * Legacy desktop tools, internal dashboards, portals with no export button —
 * the data is on screen but unreachable. Two readings are available and they
 * fail differently, so both are used:
 *
 *   - the accessibility tree gives real rows and cells where an app exposes them
 *   - positioned screen text works anywhere, and rows are recovered by grouping
 *     text runs that share a vertical band
 *
 * Collection is bounded and always partial: an unchanged page does not prove
 * the list ended. Scrolling uses only fresh native LCU indices, with its own
 * risk/grant gate; AX/OCR diagnostic coordinates never become input targets.
 */

export interface Table extends Pick<ToolOutput,'computerContent'|'data'> {
  rows: string[][];
  source: "accessibility" | "screen-text";
  note: string;
  status?:ToolStatus;
  screensRead?:number;
  complete?:boolean;
}

/** Group text runs into rows by their vertical position. */
function rowsFromText(lines: vision.OcrLine[], tolerance = 10): string[][] {
  if (!lines.length) return [];
  const sorted = [...lines].sort((a, b) => a.cy - b.cy || a.cx - b.cx);

  const bands: vision.OcrLine[][] = [];
  let current: vision.OcrLine[] = [sorted[0]];
  for (const line of sorted.slice(1)) {
    const last = current[current.length - 1];
    // Same row if the vertical centres are within a line's tolerance.
    if (Math.abs(line.cy - last.cy) <= tolerance) current.push(line);
    else {
      bands.push(current);
      current = [line];
    }
  }
  bands.push(current);

  return bands.map((band) =>
    band.sort((a, b) => a.cx - b.cx).map((l) => l.text.trim()).filter(Boolean)
  );
}

/** One pass over what is currently visible. */
export async function readVisible(expectedApp?:string): Promise<Table> {
  const dump = await ax.dump();
  if(expectedApp&&dump.app.trim().toLowerCase()!==expectedApp.trim().toLowerCase())return {rows:[],source:'accessibility',status:'partial',note:'The diagnostic AX foreground app does not match the inspected native app. No global OCR or input was used.'};
  if (dump.axAvailable) {
    const cells = dump.elements.filter((e) =>
      ["AXCell", "AXRow", "AXStaticText"].includes(e.role)
    );
    if (cells.length >= 6) {
      const rows = rowsFromText(
        cells.map((c) => ({
          text: c.label || c.value,
          cx: c.x + Math.round(c.w / 2),
          cy: c.y + Math.round(c.h / 2),
          x: c.x, y: c.y, w: c.w, h: c.h,
          confidence: 1,
        }))
      );
      if (rows.length >= 2) {
        return { rows, source: "accessibility",status:'success', note: `${dump.app} exposed ${rows.length} visible rows` };
      }
    }
  }

  // Global OCR cannot be attributed to an explicitly inspected app window.
  if(expectedApp)return {rows:[],source:'screen-text',status:'partial',note:'No reliable app-scoped rows were available. Global OCR is diagnostic only and was not substituted.'};
  const ocr = await vision.ocr("accurate");
  if (ocr.error) return { rows: [], source: "screen-text",status:'failed', note: `could not read the screen (${ocr.error})` };
  const rows = rowsFromText(ocr.lines.filter((l) => l.confidence >= 0.6));
  return { rows, source: "screen-text",status:'success', note: `read ${rows.length} visible rows from diagnostic screen text` };
}

const signature = (rows: string[][]) => rows.map((r) => r.join("|")).join("\n");

/**
 * Collect bounded visible rows, retaining progress if a native action is denied
 * or fails. Neither the screen cap nor repeated rows prove all rows were read.
 */
export async function readAll(maxScreens = 20,opts:{app?:string}={}): Promise<Table> {
  const seen = new Set<string>();
  const all: string[][] = [];
  let source: Table["source"] = "screen-text";
  let lastSig:string|undefined;
  let screens = 0;
  const consumer=new NativeConsumer(opts.app);
  let status:ToolStatus='partial',reason='Reached the bounded screen limit; the end of the list is not verified.';
  try{
    if(!Number.isSafeInteger(maxScreens)||maxScreens<1||maxScreens>40)throw Error('Use 1–40 bounded screens.');
    for(;screens<maxScreens;){
      const before=await consumer.inspect();
      const page=await readVisible(before.window.app);consumer.assertActive();
      const current=await consumer.inspect();
      source=page.source;screens++;
      for(const row of page.rows){const key=row.join('|');if(key.trim()&&!seen.has(key)){seen.add(key);all.push(row);}}
      if(page.status!=='success'||!page.rows.length){reason=page.note;break;}
      const sig=signature(page.rows);
      if(sig===lastSig){reason='Visible rows repeated after scrolling; this does not prove the end of the list.';break;}
      lastSig=sig;
      if(screens>=maxScreens)break; // Never scroll past the requested final page.
      let candidates=current.nodes.filter(node=>['scroll area','outline','collection'].includes(node.role));
      if(!candidates.length)candidates=current.nodes.filter(node=>node.role==='scroll bar');
      if(candidates.length!==1||/\bdisabled\b/i.test(candidates[0].description))throw Error('No unique enabled native scroll view exists; no target was guessed.');
      await consumer.input('scroll_in_app',current,{target:candidates[0].index,direction:'down',pages:1});
      await consumer.pause(450);
    }
  }catch(error){status=consumerStatus(error,all.length);reason=failureNote(error);}
  return {rows:all,source,status,screensRead:screens,complete:false,
    note:`${all.length} unique rows across ${screens} observed screen(s), read via ${source}. Partial collection: ${reason}`,...consumer.evidence()};
}

/** Render as CSV, quoting only what needs it. */
export function toCsv(rows: string[][]): string {
  return rows
    .map((r) =>
      r
        .map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell))
        .join(",")
    )
    .join("\n");
}
