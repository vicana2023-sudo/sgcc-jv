/* =============================================================================
   iconos.js — iconografía en SVG
   ETUL 4 S.A.

   SVG en línea, no una tipografía de iconos ni un paquete: son seis dibujos y
   traer una dependencia por eso sería desproporcionado. Heredan `currentColor`,
   así que siguen el color del botón que los contiene y funcionan igual en el
   tema claro y en el oscuro sin ninguna regla adicional.

   `aria-hidden` en todos: el icono nunca es la única señal. Lo que lee un
   lector de pantalla es el texto del botón, que siempre está.
============================================================================= */

const envolver = (d, extra = "") => `<svg class="ico" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true">${d}${extra}</svg>`;

export const ICO = {
  /* micrófono: el gesto de hablar */
  microfono: envolver(`
    <rect x="9" y="2.5" width="6" height="11" rx="3"/>
    <path d="M5.5 10.5a6.5 6.5 0 0 0 13 0"/>
    <path d="M12 17v4"/><path d="M8.5 21h7"/>`),

  /* cuadrado: detener. Universal y no se confunde con «pausa» */
  detener: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor"/></svg>`,

  /* punto relleno: grabando */
  grabando: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="6" fill="currentColor"/></svg>`,

  ondas: envolver(`
    <path d="M4 10v4"/><path d="M8 7v10"/><path d="M12 4v16"/>
    <path d="M16 8v8"/><path d="M20 11v2"/>`),

  reporte: envolver(`
    <path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z"/>
    <path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h4"/>`),

  revisar: envolver(`
    <path d="M4 12.5 9 17.5 20 6.5"/>`),

  grafo: envolver(`
    <circle cx="5" cy="6" r="2.2"/><circle cx="19" cy="7.5" r="2.2"/>
    <circle cx="12" cy="13" r="2.4"/><circle cx="6.5" cy="19" r="2.2"/>
    <path d="M6.9 7.1 10 11.4"/><path d="M17 8.5 13.8 11.6"/><path d="M11 15.1 7.8 17.2"/>`),

  persona: envolver(`
    <circle cx="12" cy="8" r="3.5"/>
    <path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>`),

  flecha: envolver(`<path d="M5 12h13"/><path d="M13 6.5 18.5 12 13 17.5"/>`),
};

/**
 * Botón con icono y texto. El texto NUNCA se omite: un icono solo obliga a
 * adivinar, y aquí hay usuarios que entran dos veces por semana.
 */
export function botonIcono(icono, texto, clase = "") {
  const b = document.createElement("button");
  b.className = ("con-ico " + clase).trim();
  b.innerHTML = ICO[icono] || "";
  b.appendChild(document.createTextNode(texto));
  return b;
}

/** Cambia el icono de un botón conservando su texto. */
export function cambiarIcono(boton, icono, texto) {
  boton.innerHTML = ICO[icono] || "";
  boton.appendChild(document.createTextNode(texto));
}
