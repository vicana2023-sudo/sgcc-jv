/* =============================================================================
   functions/index.js — agente de selección de consulta
   ETUL 4 S.A. · opcional

   Por qué existe: un sitio estático no puede llamar a un modelo de lenguaje sin
   exponer la clave en el navegador. Esta función actúa de intermediario: la clave
   vive en el servidor y nunca sale de ahí.

   El MVP funciona sin desplegar esto. La selección de consulta pasa entonces a
   modo determinista, por coincidencia léxica.

   Despliegue:
     firebase functions:secrets:set ANTHROPIC_API_KEY
     firebase deploy --only functions
   Requiere el plan Blaze (de pago por uso). Si no lo tiene, no despliegue functions
   y quite el bloque "rewrites" de firebase.json.

   Nota de diseño: esta función NO devuelve respuestas en lenguaje natural ni toca
   el grafo. Solo elige una plantilla del catálogo y rellena sus parámetros. La
   ejecución y la redacción ocurren en el cliente, sobre datos reales. Así el
   modelo no puede inventar un hecho: como mucho, puede elegir mal la plantilla,
   y eso se ve en la traza.
============================================================================= */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

const MODELO = "claude-sonnet-4-6";
const ORIGENES = [];   // vacío = mismo origen. Añada dominios si sirve desde otro sitio.

exports.agente = onRequest(
  { secrets: [ANTHROPIC_API_KEY], region: "us-central1", cors: ORIGENES.length ? ORIGENES : true,
    maxInstances: 5, timeoutSeconds: 30 },
  async (req, res) => {
    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

    const { tarea, pregunta, catalogo } = req.body || {};
    if (tarea !== "seleccionar") return res.status(400).json({ error: "Tarea no soportada" });
    if (typeof pregunta !== "string" || !pregunta.trim() || !Array.isArray(catalogo)) {
      return res.status(400).json({ error: "Faltan pregunta o catalogo" });
    }
    if (pregunta.length > 600) return res.status(400).json({ error: "Pregunta demasiado larga" });

    const sistema = `Eres un asistente que elige qué consulta ejecutar sobre un grafo de conocimiento
de una empresa de transporte urbano de Lima (ETUL 4 S.A., rutas 1100 "P", 1098 "L", 1054 y 1488 "C").

REGLAS
1. Elige exactamente una consulta del catálogo que se te entrega. No inventes identificadores.
2. Rellena solo los parámetros cuyo valor esté claro en la pregunta. Si un parámetro es opcional
   y la pregunta no lo precisa, déjalo fuera: dejarlo fuera significa "todos".
3. Si ninguna consulta del catálogo responde la pregunta, devuelve consultaId igual a null.
   Es preferible declarar que no se puede a elegir una consulta que responda otra cosa.
4. Responde solo con JSON, sin texto adicional ni marcas de código.

FORMATO
{"consultaId": "Q15" | null, "parametros": {}, "motivo": "una frase breve"}`;

    const cuerpo = {
      model: MODELO,
      max_tokens: 400,
      system: sistema,
      messages: [{ role: "user", content:
        `CATÁLOGO DE CONSULTAS\n${JSON.stringify(catalogo, null, 1)}\n\nPREGUNTA\n${pregunta}` }],
    };

    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY.value(),
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(cuerpo),
      });
      if (!r.ok) {
        const detalle = await r.text();
        console.error("Error del modelo", r.status, detalle.slice(0, 400));
        return res.status(502).json({ error: "El modelo respondió con estado " + r.status });
      }
      const data = await r.json();
      const texto = (data.content || [])
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .replace(/```json|```/g, "")
        .trim();

      let salida;
      try { salida = JSON.parse(texto); }
      catch (e) { return res.status(502).json({ error: "El modelo no devolvió JSON válido" }); }

      // El cliente vuelve a validar el identificador contra su propio catálogo,
      // así que un valor inventado aquí no llega a ejecutarse.
      return res.json({
        consultaId: salida.consultaId ?? null,
        parametros: salida.parametros && typeof salida.parametros === "object" ? salida.parametros : {},
        motivo: typeof salida.motivo === "string" ? salida.motivo.slice(0, 300) : "",
        uso: data.usage || null,
        modelo: MODELO,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Fallo al contactar al modelo" });
    }
  }
);
