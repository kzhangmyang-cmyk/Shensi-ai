const assets:Record<string,string>={acquisition:'acquisition-radar',agents:'agents-collaboration','decision-simulation':'simulation-sculpture'};
/** Art is decorative. Routes and all readable product copy remain ordinary DOM. */
export function entryArt(route:string):string {
 return `<shensi-home-art class="home-entry-art" data-kind="${route}" aria-hidden="true"><img src="/assets/home/${assets[route]}.png" alt="" width="1254" height="1254" decoding="async" draggable="false"><canvas></canvas></shensi-home-art>`;
}
