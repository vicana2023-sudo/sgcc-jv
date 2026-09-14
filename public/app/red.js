/* =============================================================================
   red.js — visualización de la red de entidades
   ETUL 4 S.A.

   Dibuja el grafo como grafo: nodos y aristas, no una tabla. Sirve para lo que
   una tabla no sirve — ver que una unidad concentra órdenes, que una regla
   cuelga de una sola fuente textual, que un repuesto es cuello de botella de
   tres talleres — y para explicar en treinta segundos qué es un grafo de
   conocimiento a alguien que nunca vio uno.

   Sin librería. Ni D3 ni vis.js: son 250 nodos como mucho, la simulación cabe
   en ochenta líneas, y el proyecto se sostiene sobre no tener dependencias.

   Canvas y no SVG: con 250 nodos y 400 aristas repintando a 60 fotogramas, SVG
   obliga al navegador a mantener miles de elementos en el árbol. En canvas es
   un bucle. El precio es que hay que resolver a mano el señalamiento del ratón,
   que son veinte líneas más abajo.

   POR QUÉ NO SE MUESTRA TODO DE GOLPE: 249 individuos y sus relaciones forman
   una maraña ilegible, de las que quedan bonitas en una lámina y no dicen nada.
   Por defecto se parte de una entidad y se abre por saltos, que es como se lee
   un grafo de verdad.
============================================================================= */

import { E, corto, NS } from "./grafo.js";

/* Paleta por clase. Dos versiones porque el canvas no hereda variables CSS: hay
   que elegir el color en JavaScript según el tema. */
const PALETA = {
  claro: ["#2F6F8F", "#3E7A5E", "#B06A11", "#9E2B20", "#6B4C9A", "#1F7A6E",
          "#8A6D1F", "#4A6FA5", "#7A5B0C", "#5C6B63"],
  oscuro: ["#72B2D0", "#6BB894", "#E0A356", "#D4776B", "#A78BD0", "#5FC4B4",
           "#D4B85C", "#8FAFD6", "#E9B531", "#92A79C"],
};

/* Clases que, de aparecer, harían el dibujo ilegible sin aportar: los catálogos
   son nodos a los que apunta casi todo, y su única forma es la de una estrella
   gigante en el centro. Se pueden volver a encender desde la leyenda. */
const APAGADAS_AL_INICIO = ["Catalogo", "TipoComponente", "Severidad", "EstadoOperativo",
                            "CategoriaVehiculo", "TipoMantenimiento", "TipoRegla", "TipoFuente"];

export function crearRed(contenedor, G, opciones = {}) {
  const alAbrir = opciones.alAbrirIndividuo || (() => {});
  const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x !== undefined) n.textContent = x; return n; };

  /* ----------------------- índice de nodos y aristas ---------------------- */
  const claseDe = new Map();     // iri -> nombre de clase «principal»
  const todas = new Set();

  /* La ontología también tiene rdf:type, así que un recorrido ingenuo de los
     sujetos mete las 77 clases y las 121 propiedades del esquema como si fueran
     datos. Aquí se dibujan INDIVIDUOS: un nodo tiene que estar tipado con una
     clase del propio dominio y no ser él mismo parte del vocabulario. */
  const ESQUEMA = new Set([
    "Class", "ObjectProperty", "DatatypeProperty", "AnnotationProperty", "Ontology",
    "Restriction", "FunctionalProperty", "InverseFunctionalProperty",
    "TransitiveProperty", "SymmetricProperty", "AsymmetricProperty", "IrreflexiveProperty",
  ].map((x) => NS.owl + x).concat([NS.rdfs + "Datatype", NS.rdfs + "Class",
    NS.rdf + "Property", NS.owl + "AllDisjointClasses"]));

  for (const [s, tripletas] of G.porSujeto) {
    if (s.startsWith("_:")) continue;
    const tipos = G.tipos(s).filter((t) => t !== NS.owl + "NamedIndividual" && !t.startsWith("_:"));
    if (!tipos.length) continue;
    if (tipos.some((t) => ESQUEMA.has(t))) continue;
    if (!tipos.some((t) => t.startsWith(NS.etul))) continue;
    /* La primera declarada, no una inferida: las inferidas son muchas y lo que
       se busca aquí es «qué es esto», no «a qué grupos pertenece». */
    const inferidas = new Set(G.inferidasDe(s));
    const principal = tipos.find((t) => !inferidas.has(t) && t.startsWith(NS.etul))
                   || tipos.find((t) => t.startsWith(NS.etul)) || tipos[0];
    const nombre = corto(principal).replace(/^etul:/, "");
    claseDe.set(s, nombre);
    todas.add(nombre);
  }

  const aristasTodas = [];
  for (const [s, tripletas] of G.porSujeto) {
    if (!claseDe.has(s)) continue;
    for (const [, p, o] of tripletas) {
      if (p === NS.rdf + "type" || typeof o !== "string" || !claseDe.has(o) || o === s) continue;
      aristasTodas.push({ a: s, b: o, prop: corto(p).replace(/^etul:/, "") });
    }
  }

  const gradoTotal = new Map();
  for (const x of aristasTodas) {
    gradoTotal.set(x.a, (gradoTotal.get(x.a) || 0) + 1);
    gradoTotal.set(x.b, (gradoTotal.get(x.b) || 0) + 1);
  }

  const clases = [...todas].sort();
  const colorDe = new Map();
  clases.forEach((c, i) => colorDe.set(c, i % PALETA.claro.length));
  const encendidas = new Set(clases.filter((c) => !APAGADAS_AL_INICIO.includes(c)));

  const vecinos = new Map();
  for (const x of aristasTodas) {
    if (!vecinos.has(x.a)) vecinos.set(x.a, []);
    if (!vecinos.has(x.b)) vecinos.set(x.b, []);
    vecinos.get(x.a).push(x.b);
    vecinos.get(x.b).push(x.a);
  }

  /* ------------------------------- estado -------------------------------- */
  const estado = { centro: null, saltos: 2, tope: 120, nodos: [], aristas: [], sobre: null };
  let lienzo = null, ctx = null, anim = null, alfa = 0, dpr = 1;
  const vista = { x: 0, y: 0, z: 1 };

  function paleta() {
    return matchMedia("(prefers-color-scheme: dark)").matches ? PALETA.oscuro : PALETA.claro;
  }
  function tinta(nombre) {
    const cs = getComputedStyle(document.documentElement);
    return cs.getPropertyValue(nombre).trim();
  }

  /* --------------------------- selección del subgrafo --------------------- */
  function construir() {
    const dentro = new Set();
    if (estado.centro && claseDe.has(estado.centro)) {
      /* Anchura primero desde el centro: así «profundidad 2» significa lo que
         cualquiera espera, y no «dos ramas completas». */
      let frente = [estado.centro];
      dentro.add(estado.centro);
      for (let d = 0; d < estado.saltos && dentro.size < estado.tope; d++) {
        const siguiente = [];
        for (const n of frente) {
          for (const v of vecinos.get(n) || []) {
            if (dentro.has(v) || !encendidas.has(claseDe.get(v))) continue;
            if (dentro.size >= estado.tope) break;
            dentro.add(v); siguiente.push(v);
          }
        }
        frente = siguiente;
        if (!frente.length) break;
      }
    } else {
      /* Sin centro: los más conectados, que son los que cuentan la estructura. */
      [...claseDe.keys()]
        .filter((n) => encendidas.has(claseDe.get(n)))
        .sort((a, b) => (gradoTotal.get(b) || 0) - (gradoTotal.get(a) || 0))
        .slice(0, estado.tope)
        .forEach((n) => dentro.add(n));
    }

    const R = Math.min(lienzo ? lienzo.width : 600, lienzo ? lienzo.height : 400) / 3;
    estado.nodos = [...dentro].map((iri, i, a) => {
      const ang = (i / a.length) * Math.PI * 2;
      return {
        iri, etiqueta: G.etiqueta(iri) || corto(iri), corto: corto(iri),
        clase: claseDe.get(iri),
        x: Math.cos(ang) * R + (Math.random() - .5) * 20,
        y: Math.sin(ang) * R + (Math.random() - .5) * 20,
        vx: 0, vy: 0,
        grado: 0, centro: iri === estado.centro,
      };
    });
    const ix = new Map(estado.nodos.map((n) => [n.iri, n]));
    estado.aristas = aristasTodas
      .filter((x) => ix.has(x.a) && ix.has(x.b))
      .map((x) => { const A = ix.get(x.a), B = ix.get(x.b); A.grado++; B.grado++; return { A, B, prop: x.prop }; });
    alfa = 1;
    if (typeof alContar === "function") alContar();
    if (!anim) bucle();
  }

  /* Lo fija pintar(); se llama desde construir() para que el recuento siga al
     subgrafo y no se quede con el del primer dibujo. */
  let alContar = null;

  /* ------------------------------ simulación ------------------------------
     Resortes en las aristas, repulsión entre todos los pares y una gravedad
     suave al centro para que los sueltos no se vayan del lienzo. Es O(n²), y
     con el tope de nodos eso son ~15 000 pares por fotograma: nada.          */
  function paso() {
    const n = estado.nodos;
    /* Ajustado a ojo sobre este grafo: con menos repulsión los nodos de grado
       alto se apelmazan en una mancha y no se distingue una relación de otra. */
    const REP = 5200, LARGO = 92, K = 0.032, GRAV = 0.012, ROCE = 0.86;

    for (let i = 0; i < n.length; i++) {
      for (let j = i + 1; j < n.length; j++) {
        const a = n[i], b = n[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { d2 = 1; dx = Math.random() - .5; dy = Math.random() - .5; }
        const f = REP / d2;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
      }
    }
    for (const e of estado.aristas) {
      const dx = e.B.x - e.A.x, dy = e.B.y - e.A.y;
      const d = Math.hypot(dx, dy) || 1;
      const f = (d - LARGO) * K;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      e.A.vx += fx; e.A.vy += fy; e.B.vx -= fx; e.B.vy -= fy;
    }
    for (const a of n) {
      a.vx -= a.x * GRAV; a.vy -= a.y * GRAV;
      /* El nodo de foco no se mueve: es el ancla de lectura. */
      if (a.centro) { a.x = 0; a.y = 0; a.vx = 0; a.vy = 0; continue; }
      a.vx *= ROCE; a.vy *= ROCE;
      a.x += a.vx * alfa; a.y += a.vy * alfa;
    }
    alfa *= 0.991;          // decae más lento: da tiempo a que el reparto se abra
  }

  /* -------------------------------- dibujo -------------------------------- */
  function radio(nd) { return nd.centro ? 11 : Math.min(4 + nd.grado * 0.9, 10); }

  function dibujar() {
    if (!ctx) return;
    const P = paleta();
    const W = lienzo.width, H = lienzo.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    /* El lienzo tiene `dpr` veces más píxeles que su tamaño en pantalla. Sin
       escalar aquí, en una pantalla de densidad doble todo se dibujaba a mitad
       de tamaño y el grafo salía apelmazado. */
    ctx.translate(W / 2 + vista.x * dpr, H / 2 + vista.y * dpr);
    ctx.scale(vista.z * dpr, vista.z * dpr);

    ctx.strokeStyle = tinta("--line-fuerte") || "#ccc";
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const e of estado.aristas) {
      if (estado.sobre && e.A !== estado.sobre && e.B !== estado.sobre) continue;
      ctx.moveTo(e.A.x, e.A.y); ctx.lineTo(e.B.x, e.B.y);
    }
    ctx.stroke();

    /* Si hay un nodo señalado, el resto se apaga: con 120 nodos, resaltar sin
       atenuar no resalta nada. */
    if (estado.sobre) {
      ctx.globalAlpha = 0.18;
      ctx.beginPath();
      for (const e of estado.aristas) {
        if (e.A === estado.sobre || e.B === estado.sobre) continue;
        ctx.moveTo(e.A.x, e.A.y); ctx.lineTo(e.B.x, e.B.y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    const cerca = estado.sobre
      ? new Set(estado.aristas.filter((e) => e.A === estado.sobre || e.B === estado.sobre)
          .flatMap((e) => [e.A, e.B]))
      : null;

    for (const nd of estado.nodos) {
      const r = radio(nd);
      const apagado = cerca && !cerca.has(nd);
      ctx.globalAlpha = apagado ? 0.25 : 1;
      ctx.beginPath();
      ctx.arc(nd.x, nd.y, r, 0, Math.PI * 2);
      ctx.fillStyle = P[colorDe.get(nd.clase) % P.length];
      ctx.fill();
      if (nd.centro || nd === estado.sobre) {
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = tinta("--amber") || "#E9B531";
        ctx.stroke();
      }
      /* Rótulo solo donde se puede leer: en el foco, en lo señalado y en lo muy
         conectado. Etiquetar 120 nodos es tapar el dibujo con texto. */
      /* Rotular 120 nodos es tapar el dibujo con texto. Se rotula lo que se
         está mirando —el foco, lo señalado, sus vecinos— y lo muy conectado;
         el resto aparece al acercarse. */
      const rotular = nd.centro || nd === estado.sobre || (cerca && cerca.has(nd))
                   || nd.grado >= 12 || vista.z > 1.7;
      if (!apagado && rotular) {
        ctx.globalAlpha = 0.95;
        ctx.font = `${nd.centro ? 600 : 400} ${11 / vista.z}px ui-sans-serif, system-ui, sans-serif`;
        ctx.fillStyle = tinta("--ink") || "#14231E";
        ctx.textAlign = "center";
        ctx.fillText(nd.corto, nd.x, nd.y - r - 5 / vista.z);
      }
    }
    ctx.globalAlpha = 1;
  }

  /* Ajusta el zoom y el centro para que todo el subgrafo quepa. Se llama al
     terminar la simulación: sin esto, el dibujo se sale del lienzo cada vez que
     el reparto de fuerzas queda más ancho que alto. */
  function encuadrar() {
    if (!estado.nodos.length || !lienzo) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of estado.nodos) {
      x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x);
      y0 = Math.min(y0, n.y); y1 = Math.max(y1, n.y);
    }
    const W = lienzo.width / dpr, H = lienzo.height / dpr;
    const ancho = Math.max(x1 - x0, 1), alto = Math.max(y1 - y0, 1);
    vista.z = Math.min((W - 70) / ancho, (H - 50) / alto, 2.2);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    vista.x = -cx * vista.z;
    vista.y = -cy * vista.z;
  }

  function bucle() {
    if (alfa > 0.005) { paso(); dibujar(); anim = requestAnimationFrame(bucle); return; }
    encuadrar();          // ya quieto: se encuadra una vez y se deja de animar
    dibujar();
    anim = null;
  }

  /* ------------------------- ratón: señalar y abrir ----------------------- */
  function enPunto(ev) {
    const r = lienzo.getBoundingClientRect();
    const px = (ev.clientX - r.left) * (lienzo.width / r.width);
    const py = (ev.clientY - r.top) * (lienzo.height / r.height);
    const x = (px - lienzo.width / 2 - vista.x * dpr) / (vista.z * dpr);
    const y = (py - lienzo.height / 2 - vista.y * dpr) / (vista.z * dpr);
    let mejor = null, mejorD = 1e9;
    for (const nd of estado.nodos) {
      const d = Math.hypot(nd.x - x, nd.y - y);
      if (d < radio(nd) + 6 && d < mejorD) { mejor = nd; mejorD = d; }
    }
    return mejor;
  }

  /* --------------------------------- interfaz ----------------------------- */
  function pintar() {
    contenedor.innerHTML = "";

    /* controles */
    const mandos = el("div", "card");
    const g = el("div", "grid");

    const selC = el("select");
    selC.add(new Option("(los más conectados del grafo)", ""));
    const porClase = {};
    for (const [iri, cl] of claseDe) (porClase[cl] = porClase[cl] || []).push(iri);
    Object.keys(porClase).sort().forEach((cl) => {
      if (!encendidas.has(cl)) return;
      const og = document.createElement("optgroup");
      og.label = cl;
      porClase[cl].sort().slice(0, 60).forEach((iri) =>
        og.appendChild(new Option(`${corto(iri)} · ${G.etiqueta(iri) || ""}`.slice(0, 60), iri)));
      selC.appendChild(og);
    });
    selC.value = estado.centro || "";
    selC.onchange = () => { estado.centro = selC.value || null; construir(); };

    const selS = el("select");
    [1, 2, 3].forEach((n) => selS.add(new Option(`${n} salto${n > 1 ? "s" : ""}`, n)));
    selS.value = estado.saltos;
    selS.onchange = () => { estado.saltos = Number(selS.value); construir(); };

    const selT = el("select");
    [60, 120, 200, 300].forEach((n) => selT.add(new Option(`${n} nodos`, n)));
    selT.value = estado.tope;
    selT.onchange = () => { estado.tope = Number(selT.value); construir(); };

    [["Centrar en", selC], ["Profundidad", selS], ["Máximo", selT]].forEach(([t, i]) => {
      const d = el("div"); d.appendChild(el("label", "lbl", t)); d.appendChild(i); g.appendChild(d);
    });
    mandos.appendChild(g);

    /* leyenda: también es el filtro por clase */
    const leyenda = el("div", "leyenda");
    const P = paleta();
    clases.forEach((cl) => {
      const b = el("button", "ley" + (encendidas.has(cl) ? " on" : ""));
      const pt = el("span", "ley-punto");
      pt.style.background = P[colorDe.get(cl) % P.length];
      b.appendChild(pt);
      b.appendChild(document.createTextNode(`${cl} (${(porClase[cl] || []).length})`));
      b.onclick = () => {
        encendidas.has(cl) ? encendidas.delete(cl) : encendidas.add(cl);
        pintar();
      };
      leyenda.appendChild(b);
    });
    /* 45 clases ocupan media pantalla. Plegada por defecto: lo que importa es
       el dibujo, y el filtro se abre cuando hace falta. */
    const det = el("details");
    det.appendChild(el("summary", null,
      `Clases en el dibujo — ${encendidas.size} de ${clases.length} encendidas`));
    det.appendChild(leyenda);
    mandos.appendChild(det);
    contenedor.appendChild(mandos);

    /* lienzo */
    const marco = el("div", "red-marco");
    lienzo = document.createElement("canvas");
    lienzo.className = "red-lienzo";
    marco.appendChild(lienzo);
    const globo = el("div", "red-globo hide");
    marco.appendChild(globo);
    const pieM = el("div", "red-pie");
    pieM.appendChild(el("span", "note", "Arrastre para mover · rueda para acercar · pulse un nodo para abrir su ficha"));
    const bCentrar = el("button", "g sm", "Encuadrar");
    bCentrar.onclick = () => { encuadrar(); dibujar(); };
    pieM.appendChild(bCentrar);
    marco.appendChild(pieM);
    contenedor.appendChild(marco);

    const cuenta = el("p", "note");
    contenedor.appendChild(cuenta);

    ctx = lienzo.getContext("2d");
    const ajustar = () => {
      const r = marco.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      lienzo.width = Math.max(320, r.width) * dpr;
      lienzo.height = 520 * dpr;
      lienzo.style.width = "100%";
      lienzo.style.height = "520px";
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      dibujar();
    };
    ajustar();
    window.addEventListener("resize", ajustar);

    /* interacción */
    let arrastrando = false, ax = 0, ay = 0;
    lienzo.onmousedown = (e) => { arrastrando = true; ax = e.clientX; ay = e.clientY; lienzo.style.cursor = "grabbing"; };
    window.addEventListener("mouseup", () => { arrastrando = false; if (lienzo) lienzo.style.cursor = "grab"; });
    lienzo.onmousemove = (e) => {
      if (arrastrando) {
        vista.x += e.clientX - ax; vista.y += e.clientY - ay;
        ax = e.clientX; ay = e.clientY; dibujar(); return;
      }
      const nd = enPunto(e);
      if (nd !== estado.sobre) {
        estado.sobre = nd;
        lienzo.style.cursor = nd ? "pointer" : "grab";
        if (nd) {
          globo.innerHTML = "";
          globo.appendChild(el("b", null, nd.corto));
          globo.appendChild(el("div", null, nd.etiqueta));
          globo.appendChild(el("div", "note", `${nd.clase} · ${nd.grado} conexión(es) en el dibujo`));
          globo.classList.remove("hide");
          const r = lienzo.getBoundingClientRect();
          globo.style.left = Math.min(e.clientX - r.left + 14, r.width - 230) + "px";
          globo.style.top = (e.clientY - r.top + 14) + "px";
        } else globo.classList.add("hide");
        dibujar();
      }
    };
    lienzo.onmouseleave = () => { estado.sobre = null; globo.classList.add("hide"); dibujar(); };
    lienzo.onclick = (e) => { const nd = enPunto(e); if (nd) alAbrir(nd.iri); };
    lienzo.onwheel = (e) => {
      e.preventDefault();
      vista.z = Math.min(4, Math.max(0.3, vista.z * (e.deltaY < 0 ? 1.12 : 0.89)));
      dibujar();
    };

    alContar = () => {
      cuenta.textContent =
        `${estado.nodos.length} nodos y ${estado.aristas.length} relaciones en pantalla, ` +
        `de ${claseDe.size} individuos y ${aristasTodas.length} relaciones del grafo completo.`;
    };
    construir();
  }

  return {
    pintar,
    centrarEn(iri) { estado.centro = iri; if (ctx) { construir(); } },
  };
}
