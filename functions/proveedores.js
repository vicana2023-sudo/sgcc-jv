/* =============================================================================
   proveedores.js — qué agente atiende, y cómo cambiarlo sin tocar código
   ETUL 4 S.A.

   El sistema corre sobre GCP, así que el proveedor por defecto es Google:
   Gemini en Vertex AI, en el mismo proyecto. Eso tiene una consecuencia
   práctica que vale más que la preferencia de marca: VERTEX AUTENTICA POR IAM,
   con la cuenta de servicio de la propia función. No hay clave de API que
   guardar, ni secreto que rotar, ni credencial que se pueda filtrar en un
   registro. El proveedor directo de Anthropic sí la necesita, y esa es la
   diferencia operativa entre los tres.

   Tres proveedores con un solo contrato:

     vertex-gemini     Gemini en Vertex AI        IAM, sin clave   (por defecto)
     vertex-anthropic  Claude en Vertex AI        IAM, sin clave
     anthropic         API directa de Anthropic   requiere ANTHROPIC_API_KEY

   Se cambia en functions/.env, sin tocar este archivo ni redactar de nuevo
   ningún prompt:

     AGENTE_PROVEEDOR=vertex-gemini
     AGENTE_MODELO=gemini-2.0-flash
     AGENTE_REGION=us-central1

   Para la tesis esto no es una comodidad de despliegue: es la condición para
   comparar. La misma pregunta, el mismo prompt, la misma herramienta y el mismo
   esquema de salida, cambiando solo el modelo. Sin esta capa, comparar dos
   proveedores exigiría dos ramas de código y la comparación no probaría nada.

   EL CONTRATO. Todo proveedor recibe {sistema, mensaje, herramienta} y devuelve
   el argumento de una llamada a herramienta que valida contra el esquema. Nunca
   texto libre: el texto libre obliga a analizarlo, y ahí es donde un modelo
   mete una explicación amable alrededor del JSON y rompe al cliente.
============================================================================= */

const PROVEEDOR = (process.env.AGENTE_PROVEEDOR || "vertex-gemini").trim();
const REGION = (process.env.AGENTE_REGION || "us-central1").trim();
const PROYECTO = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "sgcc-jv";

/* Modelo por proveedor. Se puede forzar uno con AGENTE_MODELO; existe
   justamente para poder subirlo de versión sin desplegar código nuevo. */
const POR_DEFECTO = {
  "vertex-gemini": "gemini-2.0-flash",
  "vertex-anthropic": "claude-opus-5",
  "anthropic": "claude-opus-5",
};
const MODELO = (process.env.AGENTE_MODELO || POR_DEFECTO[PROVEEDOR] || "").trim();

const necesitaClave = () => PROVEEDOR === "anthropic";

/* ---------------------------------------------------------------- Gemini ---
   Gemini acepta un subconjunto del esquema de OpenAPI, no JSON Schema entero.
   Dos diferencias que rompen en silencio si no se traducen:
     · no admite `additionalProperties`;
     · no admite `type: ["string","null"]`, usa `nullable: true`.
   Traducir aquí es lo que permite escribir el esquema UNA vez, en la forma
   canónica, y que cada proveedor reciba lo que entiende.                    */
function aEsquemaGemini(esquema, Type) {
  if (!esquema || typeof esquema !== "object") return esquema;
  const salida = {};
  for (const [k, v] of Object.entries(esquema)) {
    if (k === "additionalProperties" || k === "strict") continue;
    if (k === "type") {
      const tipos = Array.isArray(v) ? v : [v];
      const real = tipos.find((t) => t !== "null") || "string";
      salida.type = Type[String(real).toUpperCase()] || Type.STRING;
      if (tipos.includes("null")) salida.nullable = true;
      continue;
    }
    if (k === "properties") {
      salida.properties = Object.fromEntries(
        Object.entries(v).map(([n, sub]) => [n, aEsquemaGemini(sub, Type)]));
      continue;
    }
    if (k === "items") { salida.items = aEsquemaGemini(v, Type); continue; }
    salida[k] = v;
  }
  return salida;
}

async function conGemini({ sistema, mensaje, herramienta }) {
  const { GoogleGenAI, Type, FunctionCallingConfigMode } = require("@google/genai");
  const ia = new GoogleGenAI({ vertexai: true, project: PROYECTO, location: REGION });

  const r = await ia.models.generateContent({
    model: MODELO,
    contents: mensaje,
    config: {
      systemInstruction: sistema,
      /* ANY obliga a llamar a la herramienta. Sin esto, el modelo puede
         contestar en prosa y el contrato se rompe en producción, no aquí. */
      tools: [{ functionDeclarations: [{
        name: herramienta.nombre,
        description: herramienta.descripcion,
        parameters: aEsquemaGemini(herramienta.esquema, Type),
      }] }],
      toolConfig: {
        functionCallingConfig: {
          mode: FunctionCallingConfigMode.ANY,
          allowedFunctionNames: [herramienta.nombre],
        },
      },
    },
  });

  const llamadas = r.functionCalls;
  if (!llamadas || !llamadas.length) {
    throw new Error("El modelo no llamó a la herramienta");
  }
  return {
    salida: llamadas[0].args || {},
    uso: r.usageMetadata || null,
  };
}

/* -------------------------------------------------------------- Anthropic ---
   Mismo código para la API directa y para Vertex: cambia el cliente, no la
   llamada. `strict` garantiza que el argumento valide contra el esquema.   */
async function conAnthropic({ sistema, mensaje, herramienta }) {
  let cliente;
  if (PROVEEDOR === "vertex-anthropic") {
    const { AnthropicVertex } = require("@anthropic-ai/vertex-sdk");
    cliente = new AnthropicVertex({ projectId: PROYECTO, region: REGION });
  } else {
    const Anthropic = require("@anthropic-ai/sdk");
    cliente = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  const r = await cliente.messages.create({
    model: MODELO,
    max_tokens: 8000,
    /* Esfuerzo bajo a propósito: extracción sobre un texto corto, no un
       problema difícil. Subirlo encarece sin mejorar esto. */
    output_config: { effort: "low" },
    system: sistema,
    tools: [{
      name: herramienta.nombre,
      description: herramienta.descripcion,
      strict: true,
      input_schema: herramienta.esquema,
    }],
    tool_choice: { type: "tool", name: herramienta.nombre },
    messages: [{ role: "user", content: mensaje }],
  });

  const bloque = r.content.find((b) => b.type === "tool_use");
  if (!bloque) throw new Error("El modelo no llamó a la herramienta (" + r.stop_reason + ")");
  /* `input` ya viene analizado por el SDK: no se busca dentro del texto, que
     el escapado del JSON varía entre modelos. */
  return { salida: bloque.input, uso: r.usage || null };
}

/** Llama al agente configurado. Lanza si no se pudo obtener una salida válida. */
async function llamarAgente(peticion) {
  if (!MODELO) throw new Error("No hay modelo configurado para el proveedor " + PROVEEDOR);
  const fn = PROVEEDOR === "vertex-gemini" ? conGemini
           : (PROVEEDOR === "anthropic" || PROVEEDOR === "vertex-anthropic") ? conAnthropic
           : null;
  if (!fn) throw new Error("Proveedor desconocido: " + PROVEEDOR);
  const r = await fn(peticion);
  return { ...r, proveedor: PROVEEDOR, modelo: MODELO };
}

module.exports = { llamarAgente, PROVEEDOR, MODELO, REGION, necesitaClave };
