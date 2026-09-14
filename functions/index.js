/* =============================================================================
   functions/index.js — el agente del sistema
   ETUL 4 S.A.

   Un sitio estático no puede llamar a un modelo sin exponer credenciales en el
   navegador. Esta función hace de intermediario. Qué modelo atiende se decide
   en functions/.env; ver proveedores.js.

   TRES TAREAS, y ninguna toca el grafo:

     seleccionar  elige qué plantilla de consulta ejecutar y con qué parámetros.
     redactar     escribe la respuesta USANDO SOLO las filas que devolvió el
                  grafo. Es el paso que convierte esto en GraphRAG completo:
                  hasta ahora la redacción era un `switch` escrito a mano, una
                  plantilla por consulta, así que había recuperación sobre grafo
                  pero la «G» de generación no la hacía ningún modelo.
     formalizar   redacta un borrador de regla a partir de lo que dijo el
                  experto en la entrevista.

   En las tres el modelo propone y otra cosa dispone: un dato del grafo, o una
   persona. Es la decisión 1 del diseño de la tesis, sostenida en el servidor.

   Lo que «redactar» NO puede hacer, y por eso se puede defender: no recibe el
   grafo, ni la ontología, ni acceso a nada. Recibe un puñado de filas ya
   ejecutadas y la orden de no salirse de ellas. Si las filas no responden la
   pregunta, tiene que declararlo en vez de completarlo. La comparación entre su
   redacción y la determinista es medible, y el cliente conserva las dos.
============================================================================= */

const { onRequest } = require("firebase-functions/v2/https");
const { llamarAgente, PROVEEDOR, MODELO, necesitaClave } = require("./proveedores");

const ORIGENES = [];   // vacío = mismo origen. Añada dominios si sirve desde otro sitio.

/* ------------------------------- herramientas ------------------------------
   Esquema canónico en JSON Schema. proveedores.js lo traduce a lo que entiende
   cada modelo; aquí se escribe una sola vez.                                */

const H_SELECCIONAR = {
  nombre: "elegir_consulta",
  descripcion: "Registra qué consulta del catálogo responde la pregunta, y con qué parámetros.",
  esquema: {
    type: "object",
    properties: {
      consultaId: {
        type: ["string", "null"],
        description: "Identificador exacto del catálogo, o null si ninguna responde la pregunta.",
      },
      parametros: {
        type: "object",
        description: "Solo los parámetros cuyo valor esté claro en la pregunta.",
      },
      motivo: { type: "string", description: "Una frase breve, en español." },
    },
    required: ["consultaId", "parametros", "motivo"],
    additionalProperties: false,
  },
};

const H_REDACTAR = {
  nombre: "responder_con_filas",
  descripcion: "Registra la respuesta redactada a partir de las filas del grafo.",
  esquema: {
    type: "object",
    properties: {
      respuesta: {
        type: "string",
        description: "La respuesta en español del Perú, en dos o tres frases, solo con datos de las filas.",
      },
      suficiente: {
        type: "boolean",
        description: "false si las filas no bastan para responder lo que se preguntó.",
      },
    },
    required: ["respuesta", "suficiente"],
    additionalProperties: false,
  },
};

const H_FORMALIZAR = {
  nombre: "proponer_regla",
  descripcion: "Registra el borrador de regla extraído de lo que dijo el experto.",
  esquema: {
    type: "object",
    properties: {
      condicion: { type: "string", description: "SI: en qué situación aplica. Sin el «si» inicial." },
      accion: { type: "string", description: "ENTONCES: qué se debe hacer. Conserve la negación si la hay." },
      motivo: { type: "string", description: "PORQUE: el motivo que dio el experto. Vacío si no lo dio." },
      tipo: {
        type: "string",
        enum: ["ReglaDura", "ReglaPrioridad", "ReglaPreferencia", "ReglaHeuristica"],
      },
      parametro: { type: "string", description: "Nombre del parámetro que fija la regla, o vacío." },
      valor: { type: "string", description: "Valor numérico del parámetro, o vacío." },
      fragmento: {
        type: "string",
        description: "Palabras LITERALES del experto que sustentan la regla. Copiadas, no parafraseadas.",
      },
    },
    required: ["condicion", "accion", "motivo", "tipo", "parametro", "valor", "fragmento"],
    additionalProperties: false,
  },
};

/* --------------------------------- prompts -------------------------------- */

const CONTEXTO = `ETUL 4 S.A. es una empresa de transporte urbano de Lima con cuatro rutas:
1100 "P", 1098 "L", 1054 y 1488 "C".`;

const SISTEMA_SELECCIONAR = `${CONTEXTO}
Eliges qué consulta ejecutar sobre un grafo de conocimiento de su flota.

REGLAS
1. Elige exactamente una consulta del catálogo. No inventes identificadores.
2. Rellena solo los parámetros cuyo valor esté claro en la pregunta. Un parámetro opcional
   que la pregunta no precisa se deja fuera: fuera significa "todos".
3. Si ninguna consulta del catálogo responde la pregunta, devuelve consultaId igual a null.
   Es preferible declarar que no se puede a elegir una consulta que responda otra cosa.`;

const SISTEMA_REDACTAR = `${CONTEXTO}
Redactas la respuesta a una pregunta sobre la flota USANDO ÚNICAMENTE las filas que se te dan.
Esas filas salieron de ejecutar una consulta validada contra el grafo.

REGLAS, y la primera no admite excepción
1. NO añadas ningún dato que no esté en las filas. Ni un número, ni una placa, ni una fecha,
   ni una causa. Si no está en las filas, no existe para ti.
2. No expliques cómo funciona el sistema ni menciones "las filas", "la consulta" o "el grafo".
   Responde como respondería alguien del área mirando el dato.
3. Español del Perú, natural y directo. Dos o tres frases. Sin listas con viñetas.
4. Cita los identificadores y valores tal como aparecen (padrón 104, RUT-1100, 6600 km).
5. Si las filas no responden lo que se preguntó, pon suficiente en false y dilo con franqueza
   en la respuesta. Declarar que no se sabe es un resultado correcto, no un fallo.`;

const SISTEMA_FORMALIZAR = `${CONTEXTO}
Formalizas conocimiento de un experto en mantenimiento de flota. Recibes lo que acaba de decir,
hablando, y lo conviertes en una regla con la forma SI / ENTONCES / PORQUE.

REGLAS
1. No inventes nada que el experto no haya dicho. Si no dio el motivo, deja el motivo vacío.
2. Conserva las negaciones. "No lo mando al taller" y "lo mando al taller" son reglas opuestas;
   confundirlas es el peor error posible aquí.
3. El fragmento debe ser una cita LITERAL de lo que dijo, copiada tal cual, no un resumen.
   Es la evidencia de la regla y se le va a mostrar al experto para que la confirme.
4. Español del Perú, como hablaría alguien del taller. Nada de jerga académica.
5. Es un borrador: el experto lo va a corregir. Prefiere ser fiel antes que completo.`;

/* ------------------------------- la función -------------------------------
   El secreto solo se declara cuando el proveedor lo necesita. Con Vertex, la
   función se autentica por IAM con su propia cuenta de servicio y no hay
   ninguna clave que declarar, guardar ni rotar.                             */
const opciones = {
  region: "us-central1",
  cors: ORIGENES.length ? ORIGENES : true,
  maxInstances: 5,
  timeoutSeconds: 60,
};
if (necesitaClave()) {
  const { defineSecret } = require("firebase-functions/params");
  opciones.secrets = [defineSecret("ANTHROPIC_API_KEY")];
}

exports.agente = onRequest(opciones, async (req, res) => {
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method === "GET") {
    /* Sonda: qué agente está atendiendo. Sirve para comprobar de un vistazo
       que el despliegue quedó apuntando a donde se creía. */
    return res.json({ proveedor: PROVEEDOR, modelo: MODELO, tareas: ["seleccionar", "redactar", "formalizar"] });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const cuerpo = req.body || {};
  const { tarea } = cuerpo;
  let herramienta, sistema, mensaje;

  if (tarea === "seleccionar") {
    const { pregunta, catalogo } = cuerpo;
    if (typeof pregunta !== "string" || !pregunta.trim() || !Array.isArray(catalogo)) {
      return res.status(400).json({ error: "Faltan pregunta o catalogo" });
    }
    if (pregunta.length > 600) return res.status(400).json({ error: "Pregunta demasiado larga" });
    herramienta = H_SELECCIONAR;
    sistema = SISTEMA_SELECCIONAR;
    mensaje = `CATÁLOGO DE CONSULTAS\n${JSON.stringify(catalogo, null, 1)}\n\nPREGUNTA\n${pregunta}`;

  } else if (tarea === "redactar") {
    const { pregunta, consulta, filas } = cuerpo;
    if (typeof pregunta !== "string" || !pregunta.trim() || !Array.isArray(filas)) {
      return res.status(400).json({ error: "Faltan pregunta o filas" });
    }
    /* Tope de filas: no es solo coste. Con cien filas en el prompt, comprobar
       que la respuesta no inventó nada deja de ser posible a ojo, y esa
       comprobación es el aporte de la tesis. */
    if (filas.length > 40) return res.status(400).json({ error: "Demasiadas filas para redactar" });
    herramienta = H_REDACTAR;
    sistema = SISTEMA_REDACTAR;
    mensaje =
      `PREGUNTA\n${pregunta}\n\n` +
      `CONSULTA EJECUTADA\n${(consulta && consulta.id) || "?"} — ${(consulta && consulta.titulo) || ""}\n\n` +
      `FILAS DEVUELTAS POR EL GRAFO (${filas.length})\n${JSON.stringify(filas, null, 1)}`;

  } else if (tarea === "formalizar") {
    const { pregunta, respuesta } = cuerpo;
    if (typeof respuesta !== "string" || !respuesta.trim()) {
      return res.status(400).json({ error: "Falta la respuesta del experto" });
    }
    if (respuesta.length > 4000) return res.status(400).json({ error: "Respuesta demasiado larga" });
    herramienta = H_FORMALIZAR;
    sistema = SISTEMA_FORMALIZAR;
    mensaje =
      `PREGUNTA QUE SE LE HIZO AL EXPERTO\n${(pregunta && pregunta.texto) || "(sin registrar)"}\n` +
      `DESTINO EN EL MODELO\n${(pregunta && pregunta.destino) || "(sin registrar)"}\n\n` +
      `LO QUE RESPONDIÓ, TRANSCRITO\n${respuesta}`;

  } else {
    return res.status(400).json({ error: "Tarea no soportada" });
  }

  let r;
  try {
    r = await llamarAgente({ sistema, mensaje, herramienta });
  } catch (e) {
    console.error("Fallo del agente", PROVEEDOR, MODELO, e && e.message);
    const m = String((e && e.message) || e);
    /* Se distingue «la API está apagada» de «falta el permiso»: exigen cosas
       distintas del administrador, y confundirlas cuesta media tarde. */
    if (/SERVICE_DISABLED|has not been used in project|is disabled/i.test(m)) {
      return res.status(502).json({ error:
        "La API de Vertex AI (aiplatform.googleapis.com) no está habilitada en el proyecto. " +
        "El administrador debe activarla en la consola de Google Cloud." });
    }
    if (/permission|PERMISSION_DENIED|403/i.test(m)) {
      return res.status(502).json({ error:
        "La cuenta de servicio de la función no tiene permiso para usar el modelo. " +
        "Necesita el rol «Usuario de Vertex AI» (roles/aiplatform.user)." });
    }
    if (/quota|RESOURCE_EXHAUSTED|429/i.test(m)) {
      return res.status(429).json({ error: "El modelo está saturado; reintente en unos segundos" });
    }
    if (/not found|NOT_FOUND|404/i.test(m)) {
      return res.status(502).json({ error: `El modelo ${MODELO} no está disponible en esta región` });
    }
    return res.status(502).json({ error: "El agente no pudo responder" });
  }

  const s = r.salida || {};
  const comun = { uso: r.uso || null, modelo: r.modelo, proveedor: r.proveedor };

  if (tarea === "seleccionar") {
    /* El cliente vuelve a validar el identificador contra su catálogo y contra
       los permisos del rol: un valor inventado aquí no llega a ejecutarse. */
    return res.json({
      consultaId: s.consultaId ?? null,
      parametros: s.parametros && typeof s.parametros === "object" ? s.parametros : {},
      motivo: typeof s.motivo === "string" ? s.motivo.slice(0, 300) : "",
      ...comun,
    });
  }

  if (tarea === "redactar") {
    if (!s.respuesta || !String(s.respuesta).trim()) {
      return res.status(502).json({ error: "El agente no redactó nada" });
    }
    return res.json({
      respuesta: String(s.respuesta).slice(0, 1500),
      suficiente: s.suficiente !== false,
      ...comun,
    });
  }

  /* Sin evidencia no hay regla: si el modelo no citó al experto se rechaza la
     propuesta entera, en vez de dejar que el cliente guarde algo sin respaldo.
     El proponente local toma el relevo. */
  if (!s.fragmento || !String(s.fragmento).trim()) {
    return res.status(502).json({ error: "La propuesta no trae el fragmento del experto" });
  }
  return res.json({
    condicion: s.condicion || "", accion: s.accion || "", motivo: s.motivo || "",
    tipo: s.tipo || "ReglaPreferencia", parametro: s.parametro || "", valor: s.valor || "",
    fragmento: s.fragmento, ...comun,
  });
});
