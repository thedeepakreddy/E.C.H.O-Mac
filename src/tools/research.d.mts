export interface Paper {title:string;authors:string[];published:string|null;updated:string|null;abstract:string;url:string;doi:string;venue:string;kind:string;source:string;note:string}
export function crossrefPapers(data:unknown):Paper[];
export function arxivPapers(xml:string):Paper[];
export function searchResearch(args?:{query?:string;since?:string;sort?:string;source?:string;limit?:number},options?:{fetchImpl?:typeof fetch;signal?:AbortSignal;now?:()=>number;spaceRequests?:boolean}):Promise<{status:string;papers:Paper[];error?:string;query?:string;since?:string;retrievedAt?:string;sources?:{source:string;status:string;error?:string}[];note?:string}>;
