/**
 * EL SERVICIO 24/7. Corre las tareas en bucle, para vivir en un servidor.
 *
 *   npm run servicio -- [--unavez] [--cada=3600] [--estado=/data/bot.json] [--lista=/data/monedas.json]
 *                       [--smc=/data/registro-smc.json]
 *                       [--divvideo=/data/div-video.json] [--div4h1h=/data/div-4h1h.json]
 *                       [--divafinado=/data/div-afinado.json]
 *
 * POR QUE UN BUCLE Y NO UN CRON
 * -----------------------------
 * Un cron externo obliga a coordinar dos sistemas y a que el contenedor sepa la hora del host.
 * Un bucle dentro del proceso es mas simple de razonar: si el proceso vive, el bot revisa; si
 * muere, el servidor lo reinicia y vuelve a revisar. No hay estado escondido en un planificador.
 *
 * LA ESTRATEGIA ES DIARIA, asi que revisar cada hora es de sobra: la señal solo puede cambiar
 * cuando cierra una vela. Revisar mas a menudo no adelanta nada y solo gasta peticiones.
 *
 * MODO PAPEL, SIEMPRE. Este servicio no tiene codigo para enviar ordenes a ningun exchange. Para
 * que lo tuviera habria que escribirlo, no activar una variable de entorno.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { esperaTras } from "../forex/reintentos";

function txt(n: string, porDefecto: string): string {
  const m = process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
  return m ?? process.env[`BOT_${n.toUpperCase()}`] ?? porDefecto;
}
function num(n: string, d: number): number {
  const v = Number(txt(n, String(d)));
  return Number.isFinite(v) ? v : d;
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Tarea {
  nombre: string;
  args: string[];
  /** Fallos seguidos de ESTA tarea. Que una falle no puede castigar a la otra. */
  seguidos: number;
}

/** Corre una pasada del bot como proceso hijo y devuelve si fue bien. */
function unaPasada(args: string[]): Promise<boolean> {
  return new Promise((resolver) => {
    const hijo = spawn(process.execPath, args, {
      stdio: "inherit",
      env: { ...process.env },
    });
    hijo.on("close", (codigo) => resolver(codigo === 0));
    hijo.on("error", () => resolver(false));
  });
}

async function main(): Promise<void> {
  const cada = num("cada", 3600);
  const estado = txt("estado", "/data/bot.json");
  const lista = txt("lista", "/data/monedas.json");
  const capital = txt("capital", "1000");
  const riesgo = txt("riesgo", "0.01");
  const tope = txt("tope", "8");

  // El directorio del estado tiene que existir. En Railway es el volumen montado.




  console.log(
    `SERVICIO ARRANCADO · modo papel · revision cada ${cada}s\n` +
      `estado ${estado} · lista ${lista} · capital ${capital} · riesgo ${riesgo}\n`,
  );

  // EL BOT DE CRIPTO SOLO SI HAY LISTA DE MONEDAS.
  //
  // Antes el servicio abortaba entero si no la encontraba, asi que en un entorno donde solo se
  // quieren los grabadores de forex —GitHub Actions, por ejemplo, desde donde Binance devuelve
  // 451— no arrancaba nada.
  const tareas: Tarea[] = [];
  if (existsSync(lista)) {
    // El directorio del estado se crea AQUI DENTRO, no antes.
    //
    // Estaba fuera, y como la ruta por defecto es `/data` —el volumen de Railway— en cualquier
    // otro entorno el servicio moria con EACCES intentando crear un directorio en la raiz,
    // aunque el bot de cripto ni fuera a correr. Paso en GitHub Actions.
    const dirEstado = dirname(estado);
    if (!existsSync(dirEstado)) mkdirSync(dirEstado, { recursive: true });
    tareas.push({
      nombre: "bot cripto",
      seguidos: 0,
      args: [
        "--import", "tsx", "src/tools/botCli.ts",
        `--estado=${estado}`, `--lista=${lista}`,
        `--capital=${capital}`, `--riesgo=${riesgo}`, `--tope=${tope}`,
      ],
    });
  }

  // El grabador de SMC va DENTRO del mismo servicio a proposito. Una prueba hacia adelante que
  // nadie ejecuta no acumula nada, y dejarla dependiendo de que alguien lance un comando a mano
  // es lo mismo que no tenerla.
  const smc = txt("smc", "");
  if (smc) {
    const dirSmc = dirname(smc);
    if (!existsSync(dirSmc)) mkdirSync(dirSmc, { recursive: true });
    tareas.push({
      nombre: "grabador smc",
      seguidos: 0,
      args: ["--import", "tsx", "src/tools/grabarSMCCli.ts", `--registro=${smc}`, "--costebps=1"],
    });
  }
  // Los grabadores de divergencias van DENTRO del mismo ciclo: una prueba hacia adelante que
  // depende de que alguien lance un comando a mano no acumula nada.
  //
  // Son DOS registros y contestan preguntas distintas. `video` es fiel a como se cuenta la
  // estrategia y el histórico dice que pierde: se graba para ver si el backtest miente. `4h1h`
  // es la unica variante con borde medido. Mezclarlos en un registro lo invalidaria, y por eso
  // el modo va dentro de los ajustes que el grabador compara.
  // `divafinado` es la version medida de la del video: cuatro pares en vez de doce, colchon 1
  // y objetivo fijo 1,5R. Va aparte y no sustituye a `divvideo`, porque ese sigue existiendo
  // para comprobar si el backtest miente sobre la estrategia TAL COMO SE CUENTA.
  for (const [opcion, modo] of [
    ["divvideo", "video"], ["div4h1h", "4h1h"], ["divafinado", "afinado"],
  ] as const) {
    const ruta = txt(opcion, "");
    if (!ruta) continue;
    const dirDiv = dirname(ruta);
    if (!existsSync(dirDiv)) mkdirSync(dirDiv, { recursive: true });
    tareas.push({
      nombre: `divergencias ${modo}`,
      seguidos: 0,
      args: [
        "--import", "tsx", "src/tools/grabarDivergenciaCli.ts",
        `--registro=${ruta}`, `--modo=${modo}`, "--costebps=0.6",
      ],
    });
  }
  console.log(`Tareas: ${tareas.map((x) => x.nombre).join(", ")}
`);

  // UNA VUELTA Y SALIR, para que lo pueda lanzar un planificador del sistema en vez de vivir
  // como proceso. Es lo que permite correr los grabadores en un portatil que se apaga: el
  // grabador se pone al dia solo, y esta comprobado que pasar doce velas de golpe da exactamente
  // las mismas señales que haberlas pasado una a una.
  const unaVez = process.argv.includes("--unavez") || process.env.BOT_UNAVEZ === "1";

  if (tareas.length === 0) {
    console.error(
      "Ninguna tarea que correr. Pasa --lista, --smc, --divvideo, --div4h1h o --divafinado.",
    );
    process.exitCode = 1;
    return;
  }

  for (;;) {
    const inicio = Date.now();
    for (const t of tareas) {
      console.log(`--- ${t.nombre} ---`);
      const bien = await unaPasada(t.args);
      // Los fallos se cuentan por tarea: que falle una no puede castigar a la otra.
      t.seguidos = bien ? 0 : t.seguidos + 1;
      if (!bien) console.error(`${t.nombre}: pasada fallida (${t.seguidos} seguidas).`);
    }
    if (unaVez) {
      const fallos = tareas.filter((t) => t.seguidos > 0);
      console.log(
        fallos.length
          ? `Una vuelta hecha, con fallos en: ${fallos.map((t) => t.nombre).join(", ")}`
          : "Una vuelta hecha, todo bien.",
      );
      if (fallos.length === tareas.length) process.exitCode = 1;
      return;
    }
    const peor = Math.max(...tareas.map((t) => t.seguidos));
    const espera = esperaTras(peor, cada, (Date.now() - inicio) / 1000);
    console.log(`Proxima revision en ${Math.round(espera)}s.
`);
    await dormir(espera * 1000);
  }
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
