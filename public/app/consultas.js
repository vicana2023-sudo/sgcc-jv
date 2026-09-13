/* =============================================================================
   consultas.js — el conjunto de consultas de competencia, ejecutable en el navegador
   ETUL 4 S.A. · MVP

   Cada consulta es una plantilla con parámetros declarados. El agente de
   GraphRAG elige la plantilla y rellena los parámetros; no escribe SPARQL libre.

   Por qué así y no texto-a-SPARQL libre:
     - una plantilla validada no puede devolver un resultado silenciosamente mal
       formado, que es el modo de fallo más peligroso en este dominio;
     - el conjunto de plantillas es auditable y citable en la tesis;
     - permite ejecutar la demo sin backend ni motor SPARQL.
   Contra: no responde preguntas fuera del conjunto. Cuando eso pasa, el sistema
   lo declara en lugar de improvisar, que es justo lo que mide la consulta Q35.

   Cada plantilla trae su equivalente SPARQL para que pueda copiarse y ejecutarse
   en GraphDB o Fuseki sobre el mismo grafo.
============================================================================= */

import { E, corto } from "./grafo.js";

const HOY = () => new Date();
const dias = (a, b) => Math.round((a - b) / 86400000);
const fecha = (s) => (s ? new Date(s.slice(0, 10) + "T00:00:00") : null);
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

/* Catálogos usados como parámetros. Se leen del grafo, no se codifican a mano. */
export function opciones(g, clase) {
  return g.individuos(E(clase)).map((i) => ({ id: corto(i), iri: i, etiqueta: g.etiqueta(i) }));
}

/* -------------------------------------------------------------------------- */
export const CONSULTAS = [
  {
    id: "Q01",
    titulo: "Vencimientos del plan por kilometraje",
    pregunta: "¿Qué unidades tienen el mantenimiento vencido por kilometraje?",
    frases: ["vencido", "vencimiento", "servicio vencido", "mantenimiento vencido", "kilometraje",
             "toca servicio", "le toca mantenimiento", "aceite vencido", "pasado de kilometraje"],
    params: [{ n: "categoria", cat: "CategoriaVehiculo", opcional: true, etiqueta: "Categoría" }],
    columnas: ["Padrón", "Placa", "Tarea", "Km actual", "Vence en", "Restante", "Situación"],
    sparql: `SELECT ?placa ?tarea ?kmActual ?venceEn ?restante ?situacion WHERE {
  ?v a etul:Vehiculo ; etul:placa ?placa ; etul:kmActual ?kmActual ; etul:tienePlan ?plan .
  ?t etul:tareaDePlan ?plan ; rdfs:label ?tarea ; etul:intervaloKm ?intervalo .
  OPTIONAL { SELECT ?v ?t (MAX(?km) AS ?ultUso) WHERE {
      ?ot etul:ordenDeVehiculo ?v ; etul:generadaPorTarea ?t ;
          etul:estadoOrden etul:Cerrada ; etul:kmAlIngreso ?km . } GROUP BY ?v ?t }
  BIND(?ultUso + ?intervalo AS ?venceEn) BIND(?venceEn - ?kmActual AS ?restante)
} ORDER BY ?restante`,
    run(g, p) {
      const filas = [];
      for (const v of g.individuos(E("Vehiculo"))) {
        const cat = g.uno(v, E("categoria"));
        if (p.categoria && corto(cat) !== p.categoria) continue;
        const km = g.num(v, E("kmActual"));
        const plan = g.uno(v, E("tienePlan"));
        if (km === null || !plan) continue;
        for (const t of g.suj(E("tareaDePlan"), plan)) {
          const inter = g.num(t, E("intervaloKm"));
          if (inter === null) continue;
          const aviso = g.num(t, E("ventanaAvisoKm")) ?? 0;
          const usos = g
            .suj(E("ordenDeVehiculo"), v)
            .filter((ot) => g.obj(ot, E("generadaPorTarea")).includes(t) &&
                            corto(g.uno(ot, E("estadoOrden"))) === "Cerrada")
            .map((ot) => g.num(ot, E("kmAlIngreso")))
            .filter((x) => x !== null);
          const padron = g.lit(v, E("codigoInterno")) || "";
          const placa = g.lit(v, E("placa"));
          const tarea = g.etiqueta(t);
          if (!usos.length) {
            filas.push({ Padrón: padron, Placa: placa, Tarea: tarea, "Km actual": km,
              "Vence en": "—", Restante: "—", Situación: "SIN HISTORIAL", _o: 3, _iri: [v, t] });
            continue;
          }
          const vence = Math.max(...usos) + inter;
          const resta = vence - km;
          const sit = resta <= 0 ? "VENCIDO" : resta <= aviso ? "PRÓXIMO" : "AL DÍA";
          filas.push({ Padrón: padron, Placa: placa, Tarea: tarea, "Km actual": km,
            "Vence en": vence, Restante: resta, Situación: sit,
            _o: sit === "VENCIDO" ? 1 : sit === "PRÓXIMO" ? 2 : 4, _iri: [v, t] });
        }
      }
      return filas.sort((a, b) => a._o - b._o || (a.Restante === "—" ? 0 : a.Restante - b.Restante));
    },
  },

  {
    id: "Q02",
    titulo: "Disponibilidad actual de la flota",
    pregunta: "¿Cuántas unidades están disponibles ahora?",
    frases: ["disponible", "disponibilidad", "cuántas unidades operativas", "flota operativa",
             "qué buses están operativos", "cuántos buses tengo"],
    params: [],
    columnas: ["Categoría", "Total", "Disponibles", "%"],
    sparql: `SELECT ?categoria (COUNT(?v) AS ?total)
       (SUM(IF(?estado = etul:Operativo,1,0)) AS ?disponibles) WHERE {
  ?v a etul:Vehiculo ; etul:categoria ?cat ; etul:estadoActual ?estado .
  ?cat rdfs:label ?categoria . } GROUP BY ?categoria`,
    run(g) {
      const m = new Map();
      for (const v of g.individuos(E("Vehiculo"))) {
        const c = g.etiqueta(g.uno(v, E("categoria")));
        if (!m.has(c)) m.set(c, { t: 0, d: 0, iris: [] });
        const e = m.get(c);
        e.t++;
        e.iris.push(v);
        if (corto(g.uno(v, E("estadoActual"))) === "Operativo") e.d++;
      }
      const filas = [...m].map(([c, e]) => ({ Categoría: c, Total: e.t, Disponibles: e.d,
        "%": pct(e.d, e.t), _iri: e.iris }));
      const T = filas.reduce((a, f) => a + f.Total, 0), D = filas.reduce((a, f) => a + f.Disponibles, 0);
      filas.push({ Categoría: "Flota completa", Total: T, Disponibles: D, "%": pct(D, T), _iri: [] });
      return filas;
    },
  },

  {
    id: "Q04",
    titulo: "Fallas repetidas por unidad y componente",
    pregunta: "¿Qué unidades acumulan fallas repetidas del mismo componente?",
    frases: ["fallas repetidas", "vuelve a fallar", "otra vez", "tres veces", "reincidente",
             "el mismo problema", "sigue fallando", "falla recurrente"],
    params: [{ n: "umbral", tipo: "numero", def: 3, etiqueta: "Fallas mínimas" },
             { n: "dias", tipo: "numero", def: 90, etiqueta: "En los últimos días" }],
    columnas: ["Padrón", "Placa", "Componente", "Fallas", "Primera", "Última"],
    sparql: `SELECT ?placa ?componente (COUNT(?f) AS ?fallas) WHERE {
  ?f a etul:Falla ; etul:fallaEnVehiculo ?v ; etul:tipoComponente ?c ; etul:fechaReporte ?fecha .
  ?v etul:placa ?placa . ?c rdfs:label ?componente .
  FILTER(?fecha >= "2026-06-13T00:00:00"^^xsd:dateTime)
} GROUP BY ?placa ?componente HAVING (COUNT(?f) >= 3)`,
    run(g, p) {
      const umbral = Number(p.umbral) || 3;
      const desde = new Date(HOY().getTime() - (Number(p.dias) || 90) * 86400000);
      const m = new Map();
      for (const f of g.individuos(E("Falla"))) {
        const fe = fecha(g.lit(f, E("fechaReporte")));
        if (!fe || fe < desde) continue;
        const v = g.uno(f, E("fallaEnVehiculo")), c = g.uno(f, E("tipoComponente"));
        const k = v + "|" + c;
        if (!m.has(k)) m.set(k, { v, c, fs: [], iris: [] });
        m.get(k).fs.push(fe);
        m.get(k).iris.push(f);
      }
      return [...m.values()]
        .filter((x) => x.fs.length >= umbral)
        .map((x) => ({
          Padrón: g.lit(x.v, E("codigoInterno")) || "", Placa: g.lit(x.v, E("placa")),
          Componente: g.etiqueta(x.c), Fallas: x.fs.length,
          Primera: new Date(Math.min(...x.fs)).toISOString().slice(0, 10),
          Última: new Date(Math.max(...x.fs)).toISOString().slice(0, 10),
          _iri: [x.v, ...x.iris],
        }))
        .sort((a, b) => b.Fallas - a.Fallas);
    },
  },

  {
    id: "Q06",
    titulo: "Órdenes bloqueadas por falta de repuesto",
    pregunta: "¿Qué órdenes están bloqueadas y qué repuesto falta?",
    frases: ["orden bloqueada", "bloqueada por repuesto", "sin repuesto", "esperando repuesto",
             "qué repuesto falta", "por qué no avanza la orden", "trabada"],
    params: [],
    columnas: ["Orden", "Padrón", "Repuesto", "Requerido", "Stock", "Falta", "Reposición (días)"],
    sparql: `SELECT ?orden ?placa ?repuesto ?cantidad ?stockActual WHERE {
  ?ot etul:estadoOrden etul:BloqueadaPorRepuesto ; etul:ordenDeVehiculo ?v .
  ?v etul:placa ?placa .
  ?c etul:consumoEnOrden ?ot ; etul:repuestoConsumido ?r ; etul:cantidad ?cantidad .
  ?r rdfs:label ?repuesto ; etul:stockActual ?stockActual .
  FILTER(?stockActual < ?cantidad) }`,
    run(g) {
      const filas = [];
      for (const ot of g.individuos(E("OrdenBloqueada"))) {
        const v = g.uno(ot, E("ordenDeVehiculo"));
        for (const c of g.suj(E("consumoEnOrden"), ot)) {
          const r = g.uno(c, E("repuestoConsumido"));
          const req = g.num(c, E("cantidad")), st = g.num(r, E("stockActual"));
          if (st >= req) continue;
          filas.push({ Orden: corto(ot), Padrón: g.lit(v, E("codigoInterno")) || "",
            Repuesto: g.etiqueta(r), Requerido: req, Stock: st, Falta: req - st,
            "Reposición (días)": g.num(r, E("tiempoReposicionDias")) ?? "—", _iri: [ot, v, r] });
        }
      }
      return filas;
    },
  },

  {
    id: "Q13",
    titulo: "Repuestos bajo el stock mínimo",
    pregunta: "¿Qué repuestos hay que reponer?",
    frases: ["stock", "repuestos", "comprar", "reponer", "almacén", "inventario", "stock mínimo"],
    params: [],
    columnas: ["Repuesto", "Código", "Stock", "Mínimo", "A reponer", "Reposición (días)"],
    sparql: `SELECT ?repuesto ?stockActual ?stockMinimo WHERE {
  ?r a etul:Repuesto ; rdfs:label ?repuesto ;
     etul:stockActual ?stockActual ; etul:stockMinimo ?stockMinimo .
  FILTER(?stockActual < ?stockMinimo) } ORDER BY DESC(?stockMinimo - ?stockActual)`,
    run(g) {
      return g
        .individuos(E("Repuesto"))
        .map((r) => ({ r, a: g.num(r, E("stockActual")), m: g.num(r, E("stockMinimo")) }))
        .filter((x) => x.a < x.m)
        .map((x) => ({ Repuesto: g.etiqueta(x.r), Código: g.lit(x.r, E("codigoRepuesto")) || "",
          Stock: x.a, Mínimo: x.m, "A reponer": x.m - x.a,
          "Reposición (días)": g.num(x.r, E("tiempoReposicionDias")) ?? "—", _iri: [x.r] }))
        .sort((a, b) => b["A reponer"] - a["A reponer"]);
    },
  },

  {
    id: "Q16",
    titulo: "Documentos vencidos o por vencer",
    pregunta: "¿Qué unidades tienen documentos vencidos o por vencer?",
    frases: ["revisión técnica", "soat", "documento", "vence", "certificado", "autorización",
             "papeles", "retenido", "gnv"],
    params: [{ n: "tipoDocumento", cat: "TipoDocumento", opcional: true, etiqueta: "Tipo de documento" },
             { n: "dias", tipo: "numero", def: 30, etiqueta: "Horizonte en días" }],
    columnas: ["Padrón", "Placa", "Documento", "Vence", "Días", "Situación"],
    sparql: `SELECT ?placa ?documento ?fechaVencimiento WHERE {
  ?d a etul:DocumentoVehicular ; etul:documentoDeVehiculo ?v ;
     etul:tipoDocumento ?td ; etul:fechaVencimiento ?fechaVencimiento .
  ?v etul:placa ?placa . ?td rdfs:label ?documento .
  FILTER(?fechaVencimiento <= xsd:date(NOW()) + "P30D"^^xsd:dayTimeDuration)
} ORDER BY ?fechaVencimiento`,
    run(g, p) {
      const h = Number(p.dias) || 30;
      const hoy = HOY();
      return g
        .individuos(E("DocumentoVehicular"))
        .map((d) => {
          const fv = fecha(g.lit(d, E("fechaVencimiento")));
          const td = g.uno(d, E("tipoDocumento"));
          const v = g.uno(d, E("documentoDeVehiculo"));
          return { d, fv, td, v, dd: fv ? dias(fv, hoy) : null };
        })
        .filter((x) => x.fv && x.dd <= h && (!p.tipoDocumento || corto(x.td) === p.tipoDocumento))
        .map((x) => ({ Padrón: g.lit(x.v, E("codigoInterno")) || "", Placa: g.lit(x.v, E("placa")),
          Documento: g.etiqueta(x.td), Vence: g.lit(x.d, E("fechaVencimiento")), Días: x.dd,
          Situación: x.dd < 0 ? "VENCIDO" : "POR VENCER", _iri: [x.v, x.d] }))
        .sort((a, b) => a.Días - b.Días);
    },
  },

  {
    id: "Q17",
    titulo: "Cobertura de cada ruta",
    pregunta: "¿Qué rutas están en riesgo de no cubrir sus frecuencias?",
    frases: ["ruta", "cobertura", "frecuencia", "cuántas unidades tiene la ruta", "en riesgo",
             "alcanzan las unidades", "1100", "1098", "1054", "1488"],
    params: [{ n: "ruta", cat: "Ruta", opcional: true, etiqueta: "Ruta" }],
    columnas: ["Ruta", "Requeridas", "Asignadas", "Disponibles", "Brecha", "Situación"],
    sparql: `SELECT ?ruta ?requeridas ?disponibles WHERE {
  ?rt a etul:Ruta ; rdfs:label ?ruta ; etul:unidadesRequeridas ?requeridas .
  { SELECT ?rt (SUM(IF(?e = etul:Operativo,1,0)) AS ?disponibles) WHERE {
      ?v a etul:Vehiculo ; etul:rutaHabitual ?rt ; etul:estadoActual ?e . } GROUP BY ?rt }
} ORDER BY (?disponibles - ?requeridas)`,
    run(g, p) {
      return g
        .individuos(E("Ruta"))
        .filter((rt) => !p.ruta || corto(rt) === p.ruta)
        .map((rt) => {
          const req = g.num(rt, E("unidadesRequeridas")) ?? 0;
          const asig = g.suj(E("rutaHabitual"), rt);
          const disp = asig.filter((v) => corto(g.uno(v, E("estadoActual"))) === "Operativo");
          return { Ruta: g.etiqueta(rt), Requeridas: req, Asignadas: asig.length,
            Disponibles: disp.length, Brecha: disp.length - req,
            Situación: disp.length < req ? "EN RIESGO" : "CUBIERTA", _iri: [rt, ...asig] };
        })
        .sort((a, b) => a.Brecha - b.Brecha);
    },
  },

  {
    id: "Q19",
    titulo: "Unidades que pueden cubrir una ruta",
    pregunta: "¿Qué unidades disponibles pueden cubrir una ruta?",
    frases: ["quién puede cubrir", "reemplazo", "reemplazar", "qué unidad mando", "mandar unidad",
             "sustituir", "puede operar en la ruta", "mover un bus", "me falta una unidad",
             "qué unidad puedo mandar", "cubrir la ruta", "traer una unidad de otra ruta"],
    params: [{ n: "ruta", cat: "Ruta", etiqueta: "Ruta" }],
    columnas: ["Padrón", "Placa", "Categoría", "Ruta habitual", "¿Es habitual?"],
    sparql: `SELECT ?placa ?categoria WHERE {
  VALUES ?rt { etul:RUT-1100 }
  ?rt etul:rutaAutorizadaPara ?cat .
  ?v a etul:Vehiculo ; etul:placa ?placa ; etul:categoria ?cat ;
     etul:estadoActual etul:Operativo .
  ?cat rdfs:label ?categoria . }`,
    run(g, p) {
      const rt = p.ruta ? E(p.ruta) : g.individuos(E("Ruta"))[0];
      const cats = new Set(g.obj(rt, E("rutaAutorizadaPara")));
      return g
        .individuos(E("Vehiculo"))
        .filter((v) => cats.has(g.uno(v, E("categoria"))) &&
                       corto(g.uno(v, E("estadoActual"))) === "Operativo")
        .map((v) => ({ Padrón: g.lit(v, E("codigoInterno")) || "", Placa: g.lit(v, E("placa")),
          Categoría: g.etiqueta(g.uno(v, E("categoria"))),
          "Ruta habitual": g.obj(v, E("rutaHabitual")).map((x) => g.etiqueta(x)).join(", ") || "—",
          "¿Es habitual?": g.obj(v, E("rutaHabitual")).includes(rt) ? "Sí" : "No", _iri: [v, rt] }))
        .sort((a, b) => (a["¿Es habitual?"] < b["¿Es habitual?"] ? 1 : -1));
    },
  },

  {
    id: "Q15",
    titulo: "Ingresos al taller permitidos por la regla del experto",
    pregunta: "¿Cuántas unidades pueden entrar al taller sin dejar una ruta bajo el mínimo?",
    frases: ["puedo meter al taller", "cuántas puedo sacar", "sin afectar la ruta",
             "mínimo de unidades", "regla del programador", "esta noche", "puedo programar"],
    params: [],
    columnas: ["Ruta", "Disponibles", "Mínimo", "Pueden ingresar", "Regla", "Texto de la regla"],
    sparql: `SELECT ?ruta ?disponibles ?minimo ?texto WHERE {
  ?r etul:tipoRegla etul:ReglaDura ; etul:estadoValidacion etul:Aprobada ;
     etul:parametroNombre "minimoUnidadesRuta" ; etul:parametroValor ?minimo ;
     etul:aplicaARuta ?rt ; etul:textoOriginal ?texto .
  { SELECT ?rt (SUM(IF(?e = etul:Operativo,1,0)) AS ?disponibles) WHERE {
      ?v a etul:Vehiculo ; etul:rutaHabitual ?rt ; etul:estadoActual ?e . } GROUP BY ?rt } }`,
    run(g) {
      const filas = [];
      for (const r of g.individuos(E("ReglaAprobada"))) {
        if (g.lit(r, E("parametroNombre")) !== "minimoUnidadesRuta") continue;
        const min = g.num(r, E("parametroValor"));
        for (const rt of g.obj(r, E("aplicaARuta"))) {
          const disp = g.suj(E("rutaHabitual"), rt)
            .filter((v) => corto(g.uno(v, E("estadoActual"))) === "Operativo").length;
          filas.push({ Ruta: g.etiqueta(rt), Disponibles: disp, Mínimo: min,
            "Pueden ingresar": disp - min, Regla: corto(r),
            "Texto de la regla": g.lit(r, E("textoOriginal")), _iri: [r, rt] });
        }
      }
      return filas;
    },
  },

  {
    id: "Q09",
    titulo: "Reglas aprobadas del experto",
    pregunta: "¿Qué reglas del experto están aprobadas?",
    frases: ["reglas", "criterio del experto", "qué reglas hay", "restricciones",
             "preferencias", "qué dijo el jefe", "conocimiento experto"],
    params: [{ n: "tipoRegla", cat: "TipoRegla", opcional: true, etiqueta: "Tipo de regla" }],
    columnas: ["ID", "Tipo", "Texto original", "Condición", "Acción", "Fuente"],
    sparql: `SELECT ?regla ?tipo ?texto WHERE {
  ?r a etul:ReglaExperto ; etul:tipoRegla ?t ;
     etul:estadoValidacion etul:Aprobada ; etul:textoOriginal ?texto .
  ?t rdfs:label ?tipo . }`,
    run(g, p) {
      return g
        .individuos(E("ReglaAprobada"))
        .filter((r) => !p.tipoRegla || corto(g.uno(r, E("tipoRegla"))) === p.tipoRegla)
        .map((r) => ({ ID: corto(r), Tipo: g.etiqueta(g.uno(r, E("tipoRegla"))),
          "Texto original": g.lit(r, E("textoOriginal")),
          Condición: g.lit(r, E("condicion")) || "—", Acción: g.lit(r, E("accion")) || "—",
          Fuente: g.obj(r, E("fuenteExperto")).map((e) => g.lit(e, E("nombreCompleto"))).join(", "),
          _iri: [r] }));
    },
  },

  {
    id: "Q11",
    titulo: "Preventivo frente a correctivo",
    pregunta: "¿Qué proporción de mantenimiento preventivo frente a correctivo hay?",
    frases: ["preventivo", "correctivo", "proporción", "indicador", "kpi", "cuánto correctivo"],
    params: [],
    columnas: ["Categoría", "Preventivas", "Correctivas", "Total", "% preventivo"],
    sparql: `SELECT ?categoria (SUM(IF(?t = etul:Preventivo,1,0)) AS ?preventivas)
       (SUM(IF(?t = etul:Correctivo,1,0)) AS ?correctivas) WHERE {
  ?ot a etul:OrdenTrabajo ; etul:tipoMantenimiento ?t ; etul:ordenDeVehiculo ?v .
  ?v etul:categoria ?c . ?c rdfs:label ?categoria . } GROUP BY ?categoria`,
    run(g) {
      const m = new Map();
      for (const ot of g.individuos(E("OrdenTrabajo"))) {
        if (corto(g.uno(ot, E("estadoOrden"))) === "Cancelada") continue;
        const v = g.uno(ot, E("ordenDeVehiculo"));
        const c = g.etiqueta(g.uno(v, E("categoria")));
        if (!m.has(c)) m.set(c, { p: 0, k: 0, t: 0, iris: [] });
        const e = m.get(c);
        e.t++;
        e.iris.push(ot);
        const tm = corto(g.uno(ot, E("tipoMantenimiento")));
        if (tm === "Preventivo") e.p++;
        if (tm === "Correctivo") e.k++;
      }
      return [...m].map(([c, e]) => ({ Categoría: c, Preventivas: e.p, Correctivas: e.k,
        Total: e.t, "% preventivo": pct(e.p, e.t), _iri: e.iris }))
        .sort((a, b) => a["% preventivo"] - b["% preventivo"]);
    },
  },

  {
    id: "Q24",
    titulo: "Precisión de la extracción automática",
    pregunta: "¿Qué tan bien extrae hechos el modelo de lenguaje?",
    frases: ["precisión", "extracción", "cuántos hechos aceptados", "rendimiento del modelo",
             "calidad de la extracción", "alucinación", "rechazados"],
    params: [],
    columnas: ["Tipo de fuente", "Propuestos", "Aceptados", "Rechazados", "Pendientes", "Precisión %"],
    sparql: `SELECT ?tipoFuente (COUNT(?e) AS ?propuestos) WHERE {
  ?e a etul:ExtraccionLLM ; etul:derivadaDeFuente ?f ; etul:estadoExtraccion ?est .
  ?f etul:tipoFuente ?tf . ?tf rdfs:label ?tipoFuente . } GROUP BY ?tipoFuente`,
    run(g) {
      const m = new Map();
      for (const e of g.individuos(E("ExtraccionLLM"))) {
        const f = g.uno(e, E("derivadaDeFuente"));
        const tf = g.etiqueta(g.uno(f, E("tipoFuente")));
        if (!m.has(tf)) m.set(tf, { p: 0, a: 0, r: 0, x: 0, iris: [] });
        const o = m.get(tf);
        o.p++;
        o.iris.push(e);
        const st = corto(g.uno(e, E("estadoExtraccion")));
        if (st === "ExtAceptada" || st === "ExtCorregida") o.a++;
        else if (st === "ExtRechazada") o.r++;
        else o.x++;
      }
      const filas = [...m].map(([tf, o]) => ({ "Tipo de fuente": tf, Propuestos: o.p, Aceptados: o.a,
        Rechazados: o.r, Pendientes: o.x, "Precisión %": pct(o.a, o.a + o.r), _iri: o.iris }));
      const P = filas.reduce((a, f) => a + f.Aceptados, 0);
      const R = filas.reduce((a, f) => a + f.Rechazados, 0);
      filas.push({ "Tipo de fuente": "Total", Propuestos: filas.reduce((a, f) => a + f.Propuestos, 0),
        Aceptados: P, Rechazados: R, Pendientes: filas.reduce((a, f) => a + f.Pendientes, 0),
        "Precisión %": pct(P, P + R), _iri: [] });
      return filas;
    },
  },

  {
    id: "Q28",
    titulo: "Trazabilidad: de la regla al texto que la originó",
    pregunta: "¿De dónde salió cada regla del experto?",
    frases: ["de dónde salió", "trazabilidad", "origen", "quién lo dijo", "en qué se basa",
             "evidencia", "procedencia", "cómo se supo"],
    params: [],
    columnas: ["Regla", "Texto de la regla", "Fragmento que la sustenta", "Fuente", "Tipo de fuente", "Modelo"],
    sparql: `SELECT ?regla ?textoRegla ?evidencia ?fuente ?modelo WHERE {
  ?r a etul:ReglaExperto ; etul:textoOriginal ?textoRegla .
  ?e etul:materializadaEn ?r ; etul:fragmentoEvidencia ?evidencia ;
     etul:derivadaDeFuente ?f ; etul:generadaPorModelo ?m .
  ?f rdfs:label ?fuente . ?m etul:nombreModelo ?modelo . }`,
    run(g) {
      const filas = [];
      for (const e of g.individuos(E("ExtraccionLLM"))) {
        for (const r of g.obj(e, E("materializadaEn"))) {
          if (!g.esA(r, E("ReglaExperto"))) continue;
          const f = g.uno(e, E("derivadaDeFuente"));
          const m = g.uno(e, E("generadaPorModelo"));
          filas.push({ Regla: corto(r), "Texto de la regla": g.lit(r, E("textoOriginal")),
            "Fragmento que la sustenta": g.lit(e, E("fragmentoEvidencia")),
            Fuente: g.etiqueta(f), "Tipo de fuente": g.etiqueta(g.uno(f, E("tipoFuente"))),
            Modelo: g.lit(m, E("nombreModelo")), _iri: [r, e, f] });
        }
      }
      return filas.sort((a, b) => a.Regla.localeCompare(b.Regla));
    },
  },

  {
    id: "Q29",
    titulo: "Qué parte del grafo vino del modelo",
    pregunta: "¿Qué datos los puso el modelo y cuáles se cargaron a mano?",
    frases: ["qué puso el modelo", "automático", "manual", "cargado a mano",
             "cuánto es del llm", "origen de los datos"],
    params: [],
    columnas: ["Individuo", "Clase", "Confianza", "Modelo", "Revisor", "Estado"],
    sparql: `SELECT ?individuo ?clase ?modelo WHERE {
  ?e etul:materializadaEn ?ind ; etul:estadoExtraccion ?est ; etul:generadaPorModelo ?m .
  FILTER(?est IN (etul:ExtAceptada, etul:ExtCorregida))
  ?ind a ?cls . ?cls rdfs:label ?clase . ?m etul:nombreModelo ?modelo . }`,
    run(g) {
      const filas = [];
      for (const e of g.individuos(E("ExtraccionIncorporada"))) {
        for (const ind of g.obj(e, E("materializadaEn"))) {
          const cls = g.tipos(ind).filter((c) => c !== "http://www.w3.org/2002/07/owl#NamedIndividual");
          const rev = g.uno(e, E("revisadaPor"));
          filas.push({ Individuo: corto(ind), Clase: cls.map((c) => g.etiqueta(c)).join(", "),
            Confianza: g.num(e, E("confianza")) ?? "—",
            Modelo: g.lit(g.uno(e, E("generadaPorModelo")), E("nombreModelo")),
            Revisor: rev ? g.lit(rev, E("nombreCompleto")) : "—",
            Estado: g.etiqueta(g.uno(e, E("estadoExtraccion"))), _iri: [ind, e] });
        }
      }
      return filas;
    },
  },

  {
    id: "Q30",
    titulo: "Exactitud del sistema de preguntas",
    pregunta: "¿Qué tan bien responde el sistema las preguntas?",
    frases: ["exactitud", "qué tan bien responde", "evaluación", "veredicto",
             "métricas", "resultados del experimento"],
    params: [],
    columnas: ["Veredicto", "Casos", "%"],
    sparql: `SELECT ?veredicto (COUNT(?ev) AS ?casos) WHERE {
  ?ev a etul:EvaluacionRespuesta ; etul:veredicto ?vd . ?vd rdfs:label ?veredicto .
} GROUP BY ?veredicto`,
    run(g) {
      const m = new Map();
      const todas = g.individuos(E("EvaluacionRespuesta"));
      for (const ev of todas) {
        const v = g.etiqueta(g.uno(ev, E("veredicto")));
        if (!m.has(v)) m.set(v, []);
        m.get(v).push(ev);
      }
      return [...m].map(([v, l]) => ({ Veredicto: v, Casos: l.length,
        "%": pct(l.length, todas.length), _iri: l })).sort((a, b) => b.Casos - a.Casos);
    },
  },
];

export function porId(id) { return CONSULTAS.find((c) => c.id === id); }

export function ejecutar(g, id, params = {}) {
  const c = porId(id);
  if (!c) throw new Error(`No existe la consulta ${id}`);
  const p = {};
  for (const d of c.params) p[d.n] = params[d.n] ?? d.def ?? null;
  const filas = c.run(g, p);
  return { consulta: c, params: p, filas, columnas: c.columnas };
}
