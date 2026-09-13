# MVP web — Grafo de conocimiento ETUL 4 S.A.

Prototipo público y navegable de la tesis: el grafo completo, consultas sobre él, GraphRAG por consulta estructurada, captura por voz y bandeja de revisión. Todo corre en el navegador.

---

## Qué contiene

```
public/
  index.html              la aplicación
  app/
    grafo.js              analizador Turtle, índice y razonador ligero
    consultas.js          las 15 plantillas de consulta ejecutables
    rag.js                recuperación, selección de plantilla y respuesta fundamentada
    voz.js                captura hablada
    main.js               interfaz
    estilo.css
  datos/
    etul4_completa.ttl    ontología + datos de ejemplo
    banco.json            174 preguntas del banco, para la entrevista
functions/
  index.js                función servidor opcional (selección con modelo de lenguaje)
firebase.json             configuración de Hosting y del reenvío a la función
.firebaserc               identificador de su proyecto
```

Todo es estático. No hay base de datos ni backend obligatorio.

---

## Probarlo en su máquina, antes de publicar

```
cd public
python -m http.server 8000
```

Abra `http://localhost:8000` en Chrome o Edge.

Abrirlo con doble clic no funciona: el navegador bloquea la lectura del `.ttl` y el micrófono en rutas `file://`.

---

## Publicarlo en Firebase Hosting

Hosting alcanza para todo salvo el modo con modelo de lenguaje, y entra en el plan gratuito.

**1. Instalar la herramienta y entrar a su cuenta**

```
npm install -g firebase-tools
firebase login
```

**2. Crear el proyecto**

En la consola de Firebase cree un proyecto nuevo. Copie su identificador y póngalo en `.firebaserc`, reemplazando `CAMBIE-ESTO-POR-SU-PROJECT-ID`.

**3. Desplegar**

```
firebase deploy --only hosting
```

Al terminar le da la dirección pública, del tipo `https://SU-PROYECTO.web.app`. Esa es la que puede compartir con su asesor o con la empresa.

**4. Cada cambio posterior**

Vuelva a ejecutar el mismo comando. Para actualizar el grafo, reemplace `public/datos/etul4_completa.ttl` por el que genera `04_poblar_ontologia.py` y despliegue otra vez.

O deje que se publique solo: vea la sección siguiente.

---

## Despliegue continuo desde GitHub

El repositorio es <https://github.com/vicana2023-sudo/sgcc-jv>. Con esto configurado, **cada cambio que llegue a `main` y toque el sitio se verifica y se publica sin que usted haga nada**. El flujo está en `.github/workflows/desplegar-hosting.yml`.

### Lo que hace antes de publicar

No hay compilación, así que un error de sintaxis iría derecho a producción. El flujo lo detiene antes:

| Comprobación | Qué evita |
|---|---|
| Sintaxis de `public/app/*.js` | Un módulo roto que deja la página en blanco |
| Sintaxis de `functions/index.js` | Lo mismo en la función servidor |
| `banco.json` y `historias.json` son JSON válido | Que la entrevista o la validación no carguen |
| El `.ttl` existe, no está vacío y trae `@prefix etul:` y `owl:equivalentClass` | Un grafo truncado al copiarlo |
| Pestañas, secciones, roles, consultas e historias concuerdan | Un rol con una pestaña que no abre nada |

Si algo falla, no se despliega y el commit queda marcado en rojo en GitHub.

> **Cuidado con `node --check`.** Para estos archivos no sirve: con un módulo ES roto devuelve 0 y deja pasar el error. El flujo usa `node --input-type=module --check < archivo`, que sí falla. Si añade comprobaciones, respete esa forma.

### Lo que falta hacer una sola vez

El flujo necesita un secreto en el repositorio con las credenciales de despliegue. **No lo puede crear nadie más que usted**, porque implica generar una clave de su proyecto de Firebase.

Desde esta carpeta:

```bash
firebase login
```

```bash
firebase init hosting:github
```

Responda así:

- **Repositorio**: `vicana2023-sudo/sgcc-jv`
- **¿Configurar un script de compilación antes de desplegar?** → **No**. El sitio es estático.
- **¿Desplegar al canal en producción cuando se fusione a una rama?** → **No**. De eso ya se encarga `desplegar-hosting.yml`; si responde que sí, tendrá dos flujos haciendo lo mismo.

El comando crea una cuenta de servicio, guarda su JSON como secreto del repositorio y no vuelve a hacer falta. El secreto debe llamarse **`FIREBASE_SERVICE_ACCOUNT_SGCC_JV`**; compruébelo en Settings → Secrets and variables → Actions. Si quedó con otro nombre, corríjalo ahí o cambie el nombre en el flujo.

### Comprobar que quedó andando

```bash
gh workflow run "Desplegar en Firebase Hosting" --repo vicana2023-sudo/sgcc-jv
```

```bash
gh run watch --repo vicana2023-sudo/sgcc-jv
```

El flujo también se puede lanzar a mano desde la pestaña Actions, útil para republicar sin tocar el código.

### Lo que no despliega, a propósito

**Nunca despliega `functions`.** La función del modelo de lenguaje necesita el plan Blaze y el secreto `ANTHROPIC_API_KEY`; intentarlo desde el flujo fallaría en el plan gratuito. Cuando la vaya a usar, despliéguela a mano como dice la sección siguiente.

**No valida la ontología.** Comprueba que el `.ttl` esté y tenga forma, no que sea consistente. Eso es trabajo de pySHACL o de HermiT en Protégé, y va aparte.

---

## Opcional: el modo con modelo de lenguaje

Sin esto, el sistema elige la consulta por coincidencia léxica y funciona bien. Active esto solo si quiere comparar ambas selecciones, que es un resultado interesante para la tesis.

Requiere el plan Blaze, que es de pago por uso. Firebase no permite funciones en el plan gratuito.

```
firebase functions:secrets:set ANTHROPIC_API_KEY
firebase deploy --only functions,hosting
```

Después, marque la casilla «Usar modelo de lenguaje» en la pestaña Preguntar.

**Si no va a usarlo**, quite el bloque `rewrites` de `firebase.json` antes de desplegar. Así evita un error de configuración.

La clave vive en el servidor y nunca llega al navegador. La función solo elige qué plantilla ejecutar; no toca el grafo ni redacta respuestas, de modo que no puede inventar un hecho. Como mucho puede elegir mal la plantilla, y eso queda visible en la traza.

---

## Qué mirar cuando lo pruebe

**Preguntar.** Empiece por «¿Cuántas unidades puedo meter al taller esta noche sin dejar la 1100 sin cobertura?». Es el caso que combina datos operativos con una regla capturada del programador. Abra la traza: muestra qué plantillas compitieron, con qué puntaje, y cuántos hechos sustentan la respuesta.

Luego pregunte «¿cuánto gastamos en combustible?». El sistema se abstiene. Esa abstención es deliberada y se mide: distingue un sistema fundamentado de uno que improvisa.

**Explorar el grafo.** Abra un ómnibus. Las etiquetas en ámbar son clases inferidas: ningún dato las declara, las deduce el razonador a partir de `owl:equivalentClass`. Es lo que un property graph no haría.

**Reportar falla.** Escriba un texto libre. Verá que lo elegido en una lista entra como dato confirmado, y lo interpretado del texto entra como propuesta pendiente. Esa separación es el aporte central de la tesis.

**Revisión.** Ningún hecho propuesto por el modelo pasa al grafo sin aprobación. Es también el cuello de botella real del sistema, y conviene medir su tiempo de cola.

---

## Límites que conviene tener claros

**No es un motor SPARQL.** Ejecuta plantillas parametrizadas sobre un índice en memoria. Cada plantilla trae su SPARQL equivalente para correrla en GraphDB o Fuseki sobre el mismo archivo. Esa es la vía formal; esta es la demostrable sin infraestructura.

**No es un razonador OWL DL.** Cubre los patrones que usa esta ontología: `hasValue`, `someValuesFrom` sobre enumeración o sobre clase, cardinalidad mínima y máxima, y materializa las propiedades inversas. Para la verificación formal de consistencia use HermiT en Protégé.

**No hay persistencia compartida.** Lo que registre queda en su navegador. En producción eso va a Firestore, según `11_arquitectura_produccion.md`.

**Los datos son ficticios.** Las cuatro rutas son las que la empresa publica. Todo lo demás está inventado para ilustrar el modelo.

---

## Si va a compartir la dirección públicamente

Deje visible la advertencia de que los datos son ficticios: ya está en la pestaña «Acerca de» y en el pie de página. Una demo con el nombre de una empresa real y datos inventados puede malinterpretarse, y conviene que eso quede dicho por usted antes de que lo pregunte alguien más.

Si más adelante carga datos reales de la empresa, esa versión no debería ser pública. Restrinja el acceso con Firebase Auth antes de subir nada real.
