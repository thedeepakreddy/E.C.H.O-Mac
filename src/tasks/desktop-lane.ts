/** A supervised foreground workflow owns the desktop lane between its steps. */
let owner:string|undefined;
export function acquireDesktopTask(id:string):boolean {if(owner && owner!==id) return false;owner=id;return true;}
export function releaseDesktopTask(id:string):void {if(owner===id) owner=undefined;}
export function desktopTaskBusy():boolean {return owner!==undefined;}
