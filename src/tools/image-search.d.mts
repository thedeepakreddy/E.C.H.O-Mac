export interface ResearchImage {title:string;description:string;url:string;source:string;author:string;license:string;licenseUrl:string|null;markdown:string}
export function cleanImage(page:unknown):ResearchImage|null;
export function searchImages(query:string,options?:{fetchImpl?:typeof fetch;signal?:AbortSignal}):Promise<{images:ResearchImage[];note:string}>;
