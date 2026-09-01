<div align="center">

<img src="assets/readme/hero.png" alt="Ilustración de un escudo que filtra anuncios, rastreadores, cookies y otras solicitudes web no deseadas antes de que se carguen las páginas de Chromium" width="1100">

<sub>Ilustración conceptual · v1.0.0 es una versión preliminar de instalación manual y actualización manual</sub>

# uBlock Plus+

### Bloqueo de contenido impulsado por la comunidad para Chromium Manifest V3

**Sideload-first · Local-first · Código abierto · Pensado para que tú tengas el control**

[![MV3 Chromium CI](https://github.com/kayurachann/uBlock-Plus/actions/workflows/mv3-chromium.yml/badge.svg)](https://github.com/kayurachann/uBlock-Plus/actions/workflows/mv3-chromium.yml)
[![Versión más reciente](https://img.shields.io/github/v/release/kayurachann/uBlock-Plus?include_prereleases&label=preliminar&color=3b82f6)](https://github.com/kayurachann/uBlock-Plus/releases)
[![Chromium 130+](https://img.shields.io/badge/Chromium-130%2B-4285F4?logo=googlechrome&logoColor=white)](#quick-start)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-8b5cf6)](ARCHITECTURE.md)
[![GPL-3.0-or-later](https://img.shields.io/badge/licencia-GPL--3.0--or--later-22c55e)](../LICENSE.txt)

[English](../README.md) · [Deutsch](README.de.md) · [**Español**](README.es.md) · [Français](README.fr.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [Tiếng Việt](README.vi.md) · [简体中文](README.zh_CN.md) · [繁體中文](README.zh_TW.md)

[**Descargar la versión preliminar más reciente**](https://github.com/kayurachann/uBlock-Plus/releases) · [Matriz de funciones](FEATURE-MATRIX.md) · [Arquitectura](ARCHITECTURE.md) · [Filter Store](FILTER-STORE.md) · [Hoja de ruta](ROADMAP.md)

</div>

---

uBlock Plus+ es un bloqueador de contenido independiente para Chromium MV3 con licencia GPL. Combina una base probada de filtrado y compilación del proyecto original con un Filter Store comunitario, configuración portable, controles explícitos para usuarios avanzados y un funcionamiento atento al uso de memoria, sin un servicio de telemetría del proyecto ni código ejecutable remoto.

> [!IMPORTANT]
> **Estado de la versión:** v1.0.0 es una versión preliminar para instalación manual y no se actualiza automáticamente. uBlock Plus+ es un fork independiente, no una versión oficial de uBlock Origin, y no cuenta con el respaldo de Raymond Hill. Chrome MV3 no expone todos los mecanismos de bloqueo disponibles en la extensión MV2 original. La instalación manual evita la política de distribución de Chrome Web Store, pero **no** elimina las cuotas de DNR, las reglas del ciclo de vida de los service workers ni los límites de seguridad del navegador. Consulta la [matriz de compatibilidad honesta](FEATURE-MATRIX.md).

## Diseñado en torno a tus decisiones

<table>
<tr>
<td width="50%" valign="top">

### 🛡️ Bloqueo de contenido por capas

Las reglas DNR estáticas, dinámicas y de sesión funcionan junto con el filtrado cosmético, los scriptlets incluidos, el bloqueo estricto y un Smart Popup Blocker que tiene en cuenta el contexto.

</td>
<td width="50%" valign="top">

### 🧩 Filter Store comunitario

Explora el catálogo comunitario incluido o añade hasta ocho repositorios HTTPS compatibles. Cada lista remota se trata como **datos** de filtrado, nunca como código ejecutable de la extensión.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🎯 Controles para cada sitio

Elige modos de filtrado por sitio, revisa los diagnósticos de las reglas coincidentes y utiliza el selector de elementos, el zapper o el unpicker cuando una página necesite un ajuste personal.

</td>
<td width="50%" valign="top">

### 🌱 Perfiles atentos al uso de memoria

Elige `auto`, `balanced` o `low-memory`. El modo Low-memory utiliza compilación secuencial, cachés limitadas y limpieza segura sin desactivar silenciosamente los filtros habilitados.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 📦 Tu configuración, portable

Exporta y restaura los ajustes principales, las suscripciones, los repositorios, las políticas de ventanas emergentes y los filtros personalizados. El catálogo integrado es un punto de partida, no un mecanismo de dependencia.

</td>
<td width="50%" valign="top">

### 🔐 Privacidad desde el diseño

El filtrado y los diagnósticos de almacenamiento permanecen en el dispositivo. No hay una cuenta de analítica del proyecto, un SDK publicitario ni un servicio de historial de navegación; los controles de privacidad de Chrome requieren un permiso aparte y revocable.

</td>
</tr>
</table>

El conjunto completo de textos de la interfaz Power está traducido al inglés, alemán, español, francés, japonés, coreano, ruso, vietnamita, chino simplificado y chino tradicional. Las otras 61 configuraciones regionales incluidas reciben en la compilación un fallback determinista en inglés, para que ningún control nuevo aparezca vacío mientras se completa la traducción comunitaria.

<div align="center">

[Explorar todas las funciones →](FEATURE-MATRIX.md)

</div>

## Verlo en acción

<sub>Capturado desde el artefacto v1.0.0 descomprimido en un perfil nuevo de Edge · sin datos personales de navegación</sub>

<table>
<tr>
<td width="62%" valign="top">

<img src="assets/readme/filter-store.png" alt="Filter Store real de uBlock Plus+ con estimaciones de la cuota DNR, tres paquetes y la primera tarjeta de filtro comunitario">

<strong>Filter Store</strong><br>
Explora las entradas comunitarias, comprueba su impacto en la cuota y activa de forma explícita paquetes con configuraciones definidas.

</td>
<td width="38%" valign="top">

<img src="assets/readme/memory-settings.png" alt="Ajustes reales de Memory Profile de uBlock Plus+ con el modo Auto, Effective Balanced y diagnósticos del almacenamiento local">

<strong>Memory Profile</strong><br>
Selecciona Auto, Balanced o Low-memory y consulta las métricas locales de caché y almacenamiento, no mediciones de la RAM en tiempo real.

</td>
</tr>
</table>

<a id="quick-start"></a>

## Inicio rápido

<div align="center">

<img src="assets/readme/install-flow.svg" alt="Cuatro pasos: descargar y extraer, verificar SHA-256, cargar la extensión descomprimida y permitir User Scripts si aparece la opción" width="1100">

</div>

### Instalar una versión

1. Descarga `uBlock-Plus_*.chromium.zip` y su archivo `.sha256` correspondiente desde [GitHub Releases](https://github.com/kayurachann/uBlock-Plus/releases).
2. Verifica la suma de comprobación y extrae después el ZIP en una carpeta permanente.
3. Abre `chrome://extensions` o `edge://extensions`.
4. Activa el **Modo de desarrollador**, elige **Cargar descomprimida** y selecciona la carpeta extraída que contiene `manifest.json`.
5. En Chrome 138 o posterior, abre la página **Detalles** de la extensión y activa **Permitir User Scripts**. Chrome 130–137 utiliza en su lugar el interruptor global **Modo de desarrollador**. Si cambias cualquiera de estos interruptores después de instalar, pulsa **Volver a cargar** en la tarjeta de la extensión para que el contexto del service worker reconozca el nuevo estado de la API. Esto permite registrar los filtros cosméticos importados compatibles y los scriptlets incluidos en la lista permitida. Consulta la [guía de `userScripts` de Chrome](https://developer.chrome.com/docs/extensions/reference/api/userScripts).

> [!NOTE]
> Una extensión instalada manualmente no se actualiza a través de Chrome Web Store. Sigue las [versiones publicadas](https://github.com/kayurachann/uBlock-Plus/releases) y sustituye la compilación descomprimida cuando se publique una nueva versión. Instala únicamente artefactos de este repositorio y verifica la suma SHA-256 proporcionada.

<details>
<summary><strong>Verificar la suma de la versión en Windows</strong></summary>

```powershell
(Get-FileHash .\uBlock-Plus_1.0.0.chromium.zip -Algorithm SHA256).Hash
Get-Content .\uBlock-Plus_1.0.0.chromium.zip.sha256
```

Los hashes hexadecimales deben coincidir; no importa si usan mayúsculas o minúsculas.

</details>

### Compilar desde el código fuente

Requisitos: Chrome/Chromium o Edge 130+, Git con submódulos, Node.js 22+ y acceso a la red para obtener los datos de filtros durante la compilación.

<details open>
<summary><strong>Windows / PowerShell</strong></summary>

```powershell
git clone --recurse-submodules https://github.com/kayurachann/uBlock-Plus.git
cd uBlock-Plus
$version = (Get-Content -Raw package.json | ConvertFrom-Json).version
.\tools\make-mv3.ps1 -Platform chromium -Version $version
```

</details>

<details>
<summary><strong>Linux / macOS</strong></summary>

```bash
git clone --recurse-submodules https://github.com/kayurachann/uBlock-Plus.git
cd uBlock-Plus
make mv3-chromium

# Opcional: crear también el ZIP con versión y el archivo SHA-256.
VERSION=$(node -p "require('./package.json').version")
tools/make-mv3.sh chromium "$VERSION"
```

</details>

Carga `dist/build/uBlockPlus.chromium` desde la página de extensiones del navegador. El comando de PowerShell con versión y el comando de shell opcional con versión crean el ZIP y la suma de comprobación en `dist/build/`; `make mv3-chromium` sin más solo crea el directorio descomprimido.

## Cómo encajan los componentes

<div align="center">

<img src="assets/readme/feature-map.svg" alt="Flujo de filtrado desde las fuentes elegidas por el usuario, pasando por la compilación verificada, hasta DNR y el filtrado cosmético en Chromium" width="1100">

</div>

- Chrome DNR se ocupa del filtrado de red sin activar el service worker con cada solicitud.
- El service worker basado en eventos administra los ajustes, el estado del catálogo, las migraciones y las actualizaciones de reglas recuperables.
- Las listas importadas se compilan localmente como datos DNR y cosméticos; los scriptlets deben existir previamente en la lista permitida incluida.
- La compilación fuera de pantalla es temporal y se cierra cuando termina su trabajo.

[Leer la arquitectura](ARCHITECTURE.md) · [Explorar Power Runtime](POWER-RUNTIME.md) · [Revisar el modelo de amenazas](THREAT-MODEL.md) · [Entender la privacidad](PRIVACY.md) · [Consultar la investigación comunitaria](COMMUNITY-RESEARCH.md)

## Límites de seguridad y confianza

| Límite | Regla del proyecto |
| --- | --- |
| Fuentes remotas | Los catálogos y las listas HTTPS se procesan como datos con límites; se rechazan las redirecciones, los esquemas incorrectos y las cargas ejecutables. |
| Confianza del Filter Store | Las entradas integradas y personalizadas muestran su nivel de confianza. La popularidad entre la comunidad nunca eleva por sí sola una entrada a `verified`. |
| Código de la extensión | JavaScript, los scriptlets y los recursos de redirección se incluyen dentro del paquete revisado de la extensión, nunca desde una URL en tiempo de ejecución. |
| Permisos | Los permisos del filtrado principal están documentados. El permiso `privacy` de Chrome solo se solicita cuando el usuario activa esos controles y puede revocarse. |
| Datos locales | Los ajustes, los filtros compilados y los diagnósticos del tamaño de almacenamiento permanecen en el dispositivo, salvo que el usuario los exporte expresamente. |
| Integridad de la versión | La CI compila y valida el artefacto de Chromium; las versiones publicadas incluyen una suma de comprobación SHA-256. |

Los problemas de seguridad deben comunicarse de forma privada mediante [GitHub Security Advisories](https://github.com/kayurachann/uBlock-Plus/security/advisories/new), no en una incidencia pública. Consulta [SECURITY.md](../SECURITY.md) para conocer la política de notificación.

## MV3: potente, con límites claros

| Disponible hoy | Limitado por MV3 | Investigación futura, opcional |
| --- | --- | --- |
| Bloqueo de red DNR, filtrado cosmético, scriptlets incluidos, listas personalizadas/importadas, Filter Store, selector/zapper, políticas contextuales de ventanas emergentes por host, aplicación mediante observador de reglas `$popup` stock empaquetadas y del subconjunto compatible de filtros `$popup`/`$popunder` importados con procedencia redactada de ámbito/línea de origen/tipo y copia de seguridad/restauración | El registro de solicitudes en vivo, los filtros procedimentales, la observación asíncrona de ventanas emergentes, la semántica del firewall dinámico, las operaciones sobre cabeceras de respuesta y el comportamiento de redirección no ofrecen una paridad exacta con MV2 | Adaptadores Enterprise administrados y un complemento nativo de código abierto instalado de forma independiente, sujeto a RFC, consentimiento y revisión de seguridad |

El subconjunto compatible de filtros de ventanas emergentes importados se aplica ahora mediante el runtime observador. Las condiciones que no pueden representarse con exactitud—por ejemplo, las de tipo de dominio, método de solicitud o cabecera de respuesta—se mantienen diferidas explícitamente, sin aproximarlas. Las condiciones `allow` diferidas se conservan como guardas conservadoras de apertura segura (*fail-open*): una guarda solo puede aplazar la decisión y nunca permitir ni bloquear de forma aproximada. Como la aplicación sigue eventos asíncronos de pestañas y navegación de MV3, no ofrece una paridad síncrona exacta con MV2. Las reglas DNR dinámicas y de sesión comparten un único cupo de 1.000 expresiones regulares; no disponen de 1.000 cada una.

Las API públicas normales de extensiones MV3 no permiten reescribir arbitrariamente el cuerpo de las respuestas, obtener una visibilidad DNS/CNAME equivalente ni bloquear con precisión según el tamaño de la respuesta. Parte de la sintaxis de filtros MV2 no puede traducirse; consulta la matriz de funciones antes de suponer equivalencia. Las coincidencias de ventanas emergentes solo exponen localmente procedencia redactada de ámbito, línea de origen y tipo. La compilación de listas de red importadas registra motivos estables de aceptación o aplazamiento y números de línea de origen; presentar ese informe con más detalle en el panel sigue siendo una tarea de la hoja de ruta.

## Hoja de ruta

<table>
<tr>
<th width="33%">Ahora</th>
<th width="33%">A continuación</th>
<th width="33%">Más adelante</th>
</tr>
<tr>
<td valign="top">

- Reforzar Power Edition
- Validar los flujos del Filter Store
- Probar las rutas de reinicio y reversión
- Establecer referencias del modo Low-memory

</td>
<td valign="top">

- Deduplicación y partición seguras de reglas
- Diagnósticos locales más completos
- Mejoras de accesibilidad e i18n
- Informes públicos de regresiones de rendimiento

</td>
<td valign="top">

- Adaptador Enterprise administrado
- Investigación opcional sobre un complemento nativo
- Procedencia firmada del catálogo y revocación

</td>
</tr>
</table>

Los elementos de la hoja de ruta no son promesas de publicación. Una función solo se entrega después de completar su implementación, las pruebas, la gestión de migración/reversión y las revisiones de seguridad, privacidad, licencia y rendimiento. [Ver la hoja de ruta comunitaria completa →](ROADMAP.md)

## Desarrollar y contribuir

```bash
npm ci
npm run lint
npm test
node tools/validate-mv3.mjs dist/build/uBlockPlus.chromium --release
```

Las ideas y los informes son bienvenidos mediante los formularios estructurados de incidencias del repositorio:

- [Proponer una función o informar de un error](https://github.com/kayurachann/uBlock-Plus/issues/new/choose)
- [Enviar una entrada al Filter Store](https://github.com/kayurachann/uBlock-Plus/issues/new?template=filter_store_submission.yml)
- [Leer la guía de contribución](../CONTRIBUTING.md)
- [Entender la gobernanza de la comunidad](COMMUNITY-GOVERNANCE.md)
- [Revisar la propiedad y los límites de los módulos](MODULE-PLAN.md)

El repositorio conserva el historial de Git del proyecto original y mantiene [`gorhill/uBlock`](https://github.com/gorhill/uBlock) configurado como remoto `upstream` solo para descargas.

## Créditos y licencia

uBlock Plus+ es una obra derivada basada en [uBlock Origin](https://github.com/gorhill/uBlock) y en componentes MV3 heredados del proyecto original. Se conservan el copyright, las cabeceras del código fuente, el historial de autoría y las atribuciones de terceros. Consulta [NOTICE.md](../NOTICE.md).

Publicado bajo la [Licencia Pública General de GNU versión 3.0 o posterior](../LICENSE.txt).

<div align="center">

**Creado de forma abierta y moldeado por sus usuarios.**

[Volver arriba ↑](#ublock-plus)

</div>
