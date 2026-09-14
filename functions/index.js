/* =============================================================================
   functions/index.js — el agente del sistema
   ETUL 4 S.A.

   Por qué existe: un sitio estático no puede llamar a un modelo de lenguaje sin
   exponer la clave en el navegador. Esta función hace de intermediario: la clave
   vive en el gestor de secretos de Firebase y nunca sale del servidor.

   Dos tareas, y ninguna de las dos toca el grafo:

     · «seleccionar» — elige qué plantilla de consulta ejecutar y con qué
       parámetros. La ejecución y la redacción ocurren en el cliente, sobre
       filas reales. El modelo no puede inventar un hecho: como mucho puede
       elegir mal la plantilla, y eso queda visible en la traza.

     · «formalizar» — redacta un borrador de regla a partir de lo que dijo el
       experto en la entrevista. El borrador NO es la regla: el experto lo
       corrige y lo confirma, y se guarda la diferencia. Esa diferencia es lo
       que mide si el modelo formaliza bien el conocimiento hablado.

   En ambos casos el modelo propone y una persona o un dato disponen. Es la
   decisión 1 del diseño de la tesis, sostenida también aquí.

   El MVP funciona sin desplegar esto: cae a selección léxica y a un proponente
   local. Lo que cambia con la función es la calidad de la propuesta, no el
   flujo, y por eso ambos caminos se pueden comparar.

   Despliegue:
     firebase functions:secrets:set ANTHROPIC_API_KEY
     firebase deploy --only functions
   Requiere el plan Blaze.
============================================================================= */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const Anthropic = require("@anthropic-ai/sdk");

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

const MODELO = "claude-opus-5";
const ORIGENES = [];   // vacío = mismo origen. Añada dominios si sirve desde otro sitio.

/* Salida por herramienta con `strict`, no por «devuélveme JSON». El modelo no
   puede entregar algo que no valide contra el esquema, así que desaparece la
   familia de fallos en que la respuesta trae una explicación amable alrededor
   del JSON y el cliente revienta al analizarla. */
const H_SELECCIONAR = {
  name: "elegir_consulta",
  description: "Registra qué consulta del catálogo responde la pregunta, y con qué parámetros.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      consultaId: {
        type: ["string", "null"],
        description: "Identificador exacto del catálogo, o null si ninguna responde la pregunta.",
      },
      parametros: {
        type: "object",
        description: "Solo los parámetros cuyo valor esté claro en la pregunta.",
        additionalProperties: true,
      },
      motivo: { type: "string", description: "Una frase breve, en español." },
    },
    required: ["consultaId", "parametros", "motivo"],
    additionalProperties: false,
  },
};

const H_FORMALIZAR = {
  name: "proponer_regla",
  description: "Registra el borrador de regla extraído de lo que dijo el experto.",
  strict: true,
  input_schema: {
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
        description: "Las palabras LITERALES del experto que sustentan la regla. Copiadas, no parafraseadas.",
      },
    },
    required: ["condicion", "accion", "motivo", "tipo", "parametro", "valor", "fragmento"],
    additionalProperties: false,
  },
};

const SISTEMA_SELECCIONAR = `Eres un asistente que elige qué consulta ejecutar sobre un grafo de conocimiento
de una empresa de transporte urbano de Lima (ETUL 4 S.A., rutas 1100 "P", 1098 "L", 1054 y 1488 "C").

REGLAS
1. Elige exactamente una consulta del catálogo que se te entrega. No inventes identificadores.
2. Rellena solo los parámetros cuyo valor esté claro en la pregunta. Si un parámetro es opcional
   y la pregunta no lo precisa, déjalo fuera: dejarlo fuera significa "todos".
3. Si ninguna consulta del catálogo responde la pregunta, devuelve consultaId igual a null.
   Es preferible declarar que no se puede a elegir una consulta que responda otra cosa.`;

const SISTEMA_FORMALIZAR = `Formalizas conocimiento de un experto en mantenimiento de flota de ómnibus
urbanos en Lima (ETUL 4 S.A.). Recibes lo que el experto acaba de decir, hablando, y lo conviertes en
una regla con la forma SI / ENTONCES / PORQUE.

REGLAS
1. No inventes nada que el experto no haya dicho. Si no dijo el motivo, deja el motivo vacío.
2. Conserva las negaciones. "No lo mando al taller" y "lo mando al taller" son reglas opuestas;
   confundirlas es el peor error posible aquí.
3. El fragmento debe ser una cita LITERAL de lo que dijo el experto, copiada tal cual, no un resumen.
   Es la evidencia de la regla y se va a mostrar al experto para que la confirme.
4. Escribe en el español del Perú, natural, como hablaría alguien del taller. No uses jerga académica.
5. Es un borrador: el experto lo va a corregir. Prefiere ser fiel a lo dicho antes que completo.`;

exports.agente = onRequest(
  { secrets: [ANTHROPIC_API_KEY], region: "us-central1", cors: ORIGENES.length ? ORIGENES : true,
    maxInstances: 5, timeoutSeconds: 60 },
  async (req, res) => {
    if (req.method === "OPTIONS") return res.status(204).send("");
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

    try {
      const cliente = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });

      const r = await cliente.messages.create({
        model: MODELO,
        max_tokens: 8000,
        /* Esfuerzo bajo a propósito: son tareas de extracción sobre un texto
           corto, no problemas difíciles. Subirlo encarece y alarga sin mejorar
           lo que aquí se le pide. */
        output_config: { effort: "low" },
        system: sistema,
        tools: [herramienta],
        tool_choice: { type: "tool", name: herramienta.name },
        messages: [{ role: "user", content: mensaje }],
      });

      const bloque = r.content.find((b) => b.type === "tool_use");
      if (!bloque) {
        console.error("El modelo no usó la herramienta", r.stop_reason);
        return res.status(502).json({ error: "El modelo no devolvió una propuesta utilizable" });
      }
      /* `input` ya viene analizado por el SDK. No se busca dentro del texto:
         el escapado del JSON de una llamada a herramienta varía entre modelos. */
      const salida = bloque.input;

      if (tarea === "seleccionar") {
        /* El cliente vuelve a validar el identificador contra su propio
           catálogo y contra los permisos del rol, así que un valor inventado
           aquí no llega a ejecutarse. */
        return res.json({
          consultaId: salida.consultaId ?? null,
          parametros: salida.parametros && typeof salida.parametros === "object" ? salida.parametros : {},
          motivo: typeof salida.motivo === "string" ? salida.motivo.slice(0, 300) : "",
          uso: r.usage || null,
          modelo: MODELO,
        });
      }

      /* Sin evidencia no hay regla: si el modelo no citó al experto, se rechaza
         la propuesta entera en vez de dejar que el cliente guarde una regla sin
         respaldo. El proponente local toma el relevo. */
      if (!salida.fragmento || !String(salida.fragmento).trim()) {
        return res.status(502).json({ error: "La propuesta no trae el fragmento del experto" });
      }
      return res.json({
        condicion: salida.condicion || "",
        accion: salida.accion || "",
        motivo: salida.motivo || "",
        tipo: salida.tipo || "ReglaPreferencia",
        parametro: salida.parametro || "",
        valor: salida.valor || "",
        fragmento: salida.fragmento,
        uso: r.usage || null,
        modelo: MODELO,
      });

    } catch (e) {
      /* Se distingue lo que el operador puede arreglar de lo que no: una clave
         mal puesta y un corte de red exigen cosas distintas. */
      if (e instanceof Anthropic.AuthenticationError) {
        console.error("La clave ANTHROPIC_API_KEY no es válida");
        return res.status(502).json({ error: "El servidor no tiene una clave válida del modelo" });
      }
      if (e instanceof Anthropic.RateLimitError) {
        return res.status(429).json({ error: "El modelo está saturado; reintente en unos segundos" });
      }
      if (e instanceof Anthropic.APIConnectionError) {
        return res.status(502).json({ error: "No se pudo contactar al modelo" });
      }
      console.error(e);
      return res.status(500).json({ error: "Fallo al contactar al modelo" });
    }
  }
);
