const assets:Record<string,string>={acquisition:'acquisition-radar.png?v=ice-blue-20260923',agents:'agents-collaboration.png?v=ice-blue-20260923','decision-simulation':'simulation-sculpture-blue.png'};
/** Art is decorative. Routes and all readable product copy remain ordinary DOM. */
export function entryArt(route:string):string {
 return `<shensi-home-art class="home-entry-art" data-kind="${route}" aria-hidden="true"><img src="/assets/home/${assets[route]}" alt="" width="900" height="900" decoding="async" draggable="false"><canvas></canvas></shensi-home-art>`;
}
