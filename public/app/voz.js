/* =============================================================================
   voz.js — captura hablada
   ETUL 4 S.A. · MVP

   Envoltura sobre la Web Speech API con el comportamiento que el dominio exige:

   - Los resultados provisionales se muestran pero no se guardan. Solo el
     resultado final constituye un turno.
   - Chrome corta el reconocimiento solo cada cierto tiempo; aquí se reinicia
     mientras el usuario no lo haya detenido, para que una explicación larga
     del experto no se pierda a la mitad.
   - Los errores se traducen a algo accionable. «not-allowed» casi siempre
     significa que la página no está en un origen seguro.
============================================================================= */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

const MENSAJES = {
  "not-allowed": "El navegador bloqueó el micrófono. Permítalo en la barra de direcciones. " +
    "Si abrió la página con doble clic, sírvala desde http://localhost.",
  "service-not-allowed": "El servicio de reconocimiento no está disponible en este origen. " +
    "Sirva la página desde http://localhost o desde el sitio publicado.",
  "audio-capture": "No se detectó ningún micrófono.",
  network: "El reconocedor necesita conexión a internet.",
  aborted: "",
};

export function crearVoz({ onParcial, onFinal, onFin, onError, lang = "es-PE" } = {}) {
  let rec = null;
  let corriendo = false;

  function iniciar() {
    if (!SR || corriendo) return;
    rec = new SR();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    corriendo = true;

    rec.onresult = (ev) => {
      let parcial = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) onFinal && onFinal(r[0].transcript.trim());
        else parcial += r[0].transcript;
      }
      if (parcial && onParcial) onParcial(parcial.trim());
    };
    rec.onerror = (ev) => {
      if (ev.error === "no-speech") return;          // silencio, no es un fallo
      const m = MENSAJES[ev.error] ?? "Error del reconocedor: " + ev.error;
      corriendo = false;
      if (m && onError) onError(m);
      if (onFin) onFin();
    };
    rec.onend = () => {
      if (corriendo) { try { rec.start(); } catch (e) { corriendo = false; if (onFin) onFin(); } }
      else if (onFin) onFin();
    };
    try { rec.start(); }
    catch (e) { corriendo = false; if (onError) onError("No se pudo iniciar el reconocedor."); }
  }

  function detener() {
    corriendo = false;
    if (rec) { try { rec.stop(); } catch (e) {} }
  }

  return { iniciar, detener, activo: () => corriendo, disponible: !!SR, quien: null };
}

export const vozDisponible = !!SR;

/* =============================== lectura en voz ============================
   La otra mitad: que el sistema hable. El entrevistador lee la pregunta del
   banco en la pantalla, pero el experto no la está leyendo, y en una entrevista
   de campo —de pie, junto a un ómnibus— pasarle el teléfono para que lea es
   peor que leérsela.

   Es síntesis del navegador, no una grabación: la voz es la que tenga instalada
   el sistema operativo. En Windows y en Android hay voz en español; en algunos
   Linux no hay ninguna, y por eso `disponible` puede ser falso aunque la API
   exista. Se comprueba que haya al menos una voz, no que la API esté presente.
============================================================================= */

const SS = window.speechSynthesis;

export function crearLector({ lang = "es-PE", onFin, onError } = {}) {
  let leyendo = false;

  /* Las voces se cargan de forma asíncrona en Chrome: la primera llamada a
     getVoices() suele devolver una lista vacía. Se consulta en el momento de
     hablar, no al crear el lector. */
  function vozEspanola() {
    const vs = SS ? SS.getVoices() : [];
    return vs.find((v) => v.lang === lang)
        || vs.find((v) => v.lang && v.lang.startsWith("es"))
        || null;
  }

  return {
    get disponible() { return !!SS; },
    activo() { return leyendo; },

    hablar(texto) {
      if (!SS || !texto) return false;
      SS.cancel();                 // sin esto se encolan y habla todo seguido
      const u = new SpeechSynthesisUtterance(String(texto));
      const v = vozEspanola();
      if (v) u.voice = v;
      u.lang = lang;
      u.rate = 0.95;               // algo más lento: son frases técnicas
      u.onend = () => { leyendo = false; if (onFin) onFin(); };
      u.onerror = (e) => {
        leyendo = false;
        if (onFin) onFin();
        /* «interrupted» y «canceled» los provoca el propio cancel() de arriba
           al encadenar lecturas: no son fallos que merezcan un aviso. */
        if (onError && e.error && !["interrupted", "canceled"].includes(e.error)) {
          onError("No se pudo leer en voz alta (" + e.error + ").");
        }
      };
      leyendo = true;
      SS.speak(u);
      return true;
    },

    detener() { if (SS) SS.cancel(); leyendo = false; },
  };
}

export const lecturaDisponible = !!SS;
