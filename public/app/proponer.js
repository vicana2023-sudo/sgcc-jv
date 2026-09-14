/* =============================================================================
   proponer.js — el agente redacta la regla; el experto la corrige y la firma
   ETUL 4 S.A.

   Antes, formalizar una regla era rellenar un formulario en blanco. El
   entrevistador escribía la condición y la acción a partir de lo que acababa de
   oír, y ahí se colaba el problema de fondo de la elicitación de conocimiento:
   lo que queda escrito es la interpretación del entrevistador, no la del
   experto, y nadie puede distinguir después una de otra.

   Ahora el agente propone y el experto dispone. Cambia quién escribe primero, y
   con ello lo que se puede medir: se guarda la propuesta original junto a la
   versión final, así que se sabe QUÉ PARTE DE LA REGLA SOBREVIVIÓ AL EXPERTO.
   Esa tasa es un resultado de la tesis, no un detalle de interfaz: mide si el
   modelo formaliza bien el conocimiento hablado o si solo lo parece.

   Dos proponentes con el mismo contrato de salida:

     · el modelo de lenguaje, cuando la función servidor está desplegada;
     · un proponente léxico local, cuando no.

   El local no pretende ser bueno. Pretende que la interfaz sea la misma con
   modelo y sin él, para que la comparación entre ambos sea posible y para que
   el prototipo funcione sin clave ni plan de pago. Lo que sí garantiza es el
   contrato que la tesis exige: NUNCA propone una regla sin el fragmento
   literal del experto que la sustenta.
============================================================================= */

/* Verbos y giros con que un experto peruano de taller enuncia una obligación,
   una prohibición o una preferencia. Salen de las respuestas del banco; no son
   una gramática, son un punto de partida que el experto va a corregir. */
const MARCAS_CONDICION = [
  "si ", "cuando ", "siempre que ", "cada vez que ", "en caso de", "si es que",
  "mientras ", "apenas ", "una vez que",
];
const MARCAS_ACCION = [
  "hay que", "se debe", "debe ", "tiene que", "tenemos que", "se manda",
  "lo mando", "lo saco", "no se puede", "no debe", "jamás", "nunca ",
  "prioridad", "primero ", "se para", "para el bus", "entra al taller",
];
const MARCAS_MOTIVO = [
  "porque", "por que", "ya que", "para evitar", "si no", "sino ", "puesto que",
  "de lo contrario", "por eso",
];

/* Tipo de regla según cómo esté enunciada. El orden importa: una prohibición
   dicha con «nunca» es restricción dura aunque también diga «primero».

   Los identificadores son los del catálogo del banco (datos/banco.json,
   cat.TipoRegla) y NO pueden inventarse aquí: si no coinciden, el desplegable
   no encuentra la opción, cae en la primera y la propuesta del agente se
   descarta sin decir nada. Pasó: se emitía «RestriccionDura» contra un catálogo
   que dice «ReglaDura», y el tipo propuesto nunca llegaba a la pantalla. */
const TIPOS = [
  { id: "ReglaDura", marcas: ["nunca", "jamás", "no se puede", "no debe", "prohibido", "de ninguna manera"] },
  { id: "ReglaPrioridad", marcas: ["prioridad", "primero", "antes que", "más importante", "urgente"] },
  { id: "ReglaPreferencia", marcas: ["prefiero", "mejor", "conviene", "trato de", "normalmente", "por lo general"] },
  { id: "ReglaHeuristica", marcas: ["depende", "según", "a ojo", "por experiencia", "uno ya sabe"] },
];

const limpiar = (s) => String(s || "").replace(/\s+/g, " ").trim();

/** Corta en frases sin romper números decimales ni abreviaturas comunes. */
function frases(texto) {
  return limpiar(texto)
    .split(/(?<![0-9])[.;]+(?=\s|$)|\n+/)
    .map((f) => limpiar(f))
    .filter((f) => f.length > 3);
}

function buscar(fs, marcas) {
  const bajo = fs.map((f) => f.toLowerCase());
  for (let i = 0; i < fs.length; i++) {
    const m = marcas.find((k) => bajo[i].includes(k));
    if (m) return { frase: fs[i], marca: m, i };
  }
  return null;
}

/**
 * Propuesta local por reglas léxicas.
 * @param {string} texto      lo que dijo el experto (uno o varios turnos)
 * @param {object} pregunta   la pregunta del banco, para el contexto
 * @returns {object} misma forma que devuelve el modelo
 */
export function proponerLocal(texto, pregunta = {}) {
  const fs = frases(texto);
  const t = limpiar(texto);
  const bajo = t.toLowerCase();

  const cond = buscar(fs, MARCAS_CONDICION);
  const acc = buscar(fs, MARCAS_ACCION);
  const mot = buscar(fs, MARCAS_MOTIVO);

  /* Un número con unidad es casi siempre el parámetro de la regla: «tres
     unidades», «5000 km», «dos días». Se toma el primero que vaya acompañado
     de algo que lo mida. */
  const PALABRAS = { un: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6,
                     siete: 7, ocho: 8, nueve: 9, diez: 10, quince: 15, veinte: 20 };
  let valor = null, unidad = "";
  const mNum = bajo.match(/\b(\d{1,6})\s*(km|kil[oó]metros?|d[ií]as?|horas?|unidades?|buses|veces)\b/);
  if (mNum) { valor = Number(mNum[1]); unidad = mNum[2]; }
  else {
    const mPal = bajo.match(new RegExp(`\\b(${Object.keys(PALABRAS).join("|")})\\s+(unidades?|buses|d[ií]as?|veces|horas?)\\b`));
    if (mPal) { valor = PALABRAS[mPal[1]]; unidad = mPal[2]; }
  }

  const parametro = !valor ? ""
    : /km|kil/.test(unidad) ? "umbralKilometraje"
    : /d[ií]a/.test(unidad) ? "diasAnticipacion"
    : /hora/.test(unidad) ? "horasDisponibles"
    : /vez|veces/.test(unidad) ? "repeticionesParaAlerta"
    : "minimoUnidadesRuta";

  let tipo = (TIPOS.find((x) => x.marcas.some((m) => bajo.includes(m))) || { id: "ReglaPreferencia" }).id;

  /* La condición y la acción suelen venir en la misma frase: «si queda menos de
     tres unidades no lo saco». Cuando es así, se parte por la marca de acción
     en vez de repetir la frase entera en los dos campos. */
  let condicion = cond ? cond.frase : "";
  let accion = acc ? acc.frase : "";
  if (cond && acc && cond.i === acc.i) {
    const f = cond.frase;
    let corte = f.toLowerCase().indexOf(acc.marca);
    /* La negación va delante del verbo y no dentro de la marca: «...no lo mando
       al taller» cortado en «lo mando» produce una acción que dice lo contrario
       de lo que dijo el experto, y deja un «no» huérfano al final de la
       condición. Se retrocede el corte para llevarse la negación con la acción.
       Es el fallo más grave que puede cometer este proponente: invierte el
       sentido de la regla y se lee perfectamente bien. */
    if (corte > 0) {
      const antes = f.slice(0, corte);
      const neg = antes.match(/(?:^|\s)(no|nunca|jam[aá]s|tampoco)\s+$/i);
      if (neg) corte -= neg[0].length;
      condicion = limpiar(f.slice(0, corte));
      accion = limpiar(f.slice(corte));
    }
  }
  /* Una acción enunciada en negativo —«no lo mando al taller»— es categórica
     aunque no aparezca ninguna de las palabras de arriba. Se clasifica por la
     forma del enunciado y no solo por su vocabulario. */
  if (/^\s*(no|nunca|jam[aá]s|tampoco)\s/i.test(accion)) tipo = "ReglaDura";

  /* Sin marca de condición pero con acción clara, la condición es el contexto
     de la pregunta: mejor eso que dejarlo vacío y que parezca un fallo. */
  if (!condicion && accion && pregunta.texto) condicion = `En el caso que plantea ${pregunta.id || "la pregunta"}`;

  const campos = {
    condicion: limpiar(condicion).replace(/^si\s+/i, ""),
    accion: limpiar(accion),
    motivo: mot ? limpiar(mot.frase.slice(mot.frase.toLowerCase().indexOf(mot.marca) + mot.marca.length)) : "",
    tipo,
    parametro,
    valor: valor === null ? "" : String(valor),
  };

  /* Cuántos campos se pudieron proponer, sobre los que importan. No es una
     probabilidad: es cuánto se atrevió a proponer el proponente, y sirve para
     que el entrevistador sepa si está revisando o redactando. */
  const utiles = ["condicion", "accion", "motivo", "valor"];
  const llenos = utiles.filter((k) => campos[k]).length;

  return {
    ...campos,
    fragmento: t,                    // sin evidencia no hay regla
    origen: "proponente léxico local",
    completitud: llenos / utiles.length,
    aviso: llenos <= 1
      ? "El proponente apenas pudo extraer nada de lo dicho. Redacte la regla usted y confírmela con el experto."
      : "",
  };
}

/**
 * Propuesta con el modelo de lenguaje, si la función servidor está desplegada.
 * Cae al proponente local ante cualquier fallo: una entrevista no se detiene
 * porque un servicio no conteste.
 */
export async function proponerConModelo(endpoint, texto, pregunta) {
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tarea: "formalizar",
      pregunta: { id: pregunta.id, texto: pregunta.texto, destino: pregunta.destino },
      respuesta: texto,
    }),
  });
  if (!r.ok) throw new Error("estado " + r.status);
  const j = await r.json();
  return {
    condicion: limpiar(j.condicion), accion: limpiar(j.accion), motivo: limpiar(j.motivo),
    tipo: j.tipo || "ReglaPreferencia", parametro: j.parametro || "", valor: j.valor ?? "",
    fragmento: limpiar(j.fragmento) || limpiar(texto),
    origen: "modelo de lenguaje",
    completitud: 1,
    aviso: "",
  };
}

/**
 * Compara lo propuesto con lo que quedó tras pasar por el experto.
 * Es lo que convierte esta pantalla en una medición: dice qué campos tocó y
 * cuánto del texto propuesto sobrevivió.
 */
export function compararConPropuesta(propuesta, final) {
  const campos = ["condicion", "accion", "motivo", "tipo", "parametro", "valor"];
  const tocados = campos.filter((k) => limpiar(propuesta[k]) !== limpiar(final[k]));
  return {
    camposTocados: tocados,
    intacta: tocados.length === 0,
    /* Proporción de campos que el experto dejó como venían. Con muestras de una
       entrevista no es una métrica; con las 252 preguntas de competencia, sí. */
    supervivencia: (campos.length - tocados.length) / campos.length,
  };
}
