/**
 * Mide el coste REAL en el libro de ordenes de Binance, y lo acumula.
 *
 *   npm run coste:libro -- --registro=RUTA.json [--nocional=1000] [--comision=15]
 *
 * POR QUE
 * -------
 * El coste es lo que ha matado a todas las estrategias medidas aqui, y es el unico numero que
 * nunca se habia medido: 10 puntos basicos planos para las treinta monedas, puestos a ojo.
 *
 * Una sola mirada al libro basta para ver que eso es falso. BTCUSDT tiene el spread pegado al
 * tick; INJUSDT —una de las treinta, y con posicion abierta— se come 9 puntos basicos de
 * deslizamiento con 10.000 dolares.
 *
 * SE ACUMULA, NO SE MIDE UNA VEZ
 * ------------------------------
 * Una foto del libro a las tres de la madrugada de un domingo no dice lo que cuesta operar. El
 * spread cambia con la hora, con la volatilidad y con el panico, y lo que importa es lo que se
 * paga CUANDO SE OPERA, que suele ser en los peores momentos. Por eso se guarda la serie y se
 * reporta la mediana y el percentil 90.
 *
 * Solo añade muestras: nunca reescribe una ya tomada. Misma regla que los grabadores.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import axios from "axios";
import { medirLibro, resumir, type Libro, type CosteMedido } from "../forex/libro";

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
function txt(n: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
}
function num(n: string, d: number): number {
  const m = txt(n);
  if (m === undefined) return d;
  const v = Number(m);
  return Number.isFinite(v) ? v : d;
}

interface Registro {
  version: 1;
  inicio: string;
  ultima: string;
  muestras: CosteMedido[];
}

async function libroDe(simbolo: string): Promise<Libro> {
  const { data } = await axios.get("https://api.binance.com/api/v3/depth", {
    params: { symbol: simbolo, limit: 500 },
    timeout: 15_000,
  });
  const nivel = ([p, c]: [string, string]) => ({ precio: Number(p), cantidad: Number(c) });
  return {
    simbolo,
    t: Math.floor(Date.now() / 1000),
    demandas: (data.bids as Array<[string, string]>).map(nivel),
    ofertas: (data.asks as Array<[string, string]>).map(nivel),
  };
}

async function main(): Promise<void> {
  const ruta = txt("registro");
  if (!ruta) {
    console.error("Falta --registro=RUTA.json");
    process.exitCode = 1;
    return;
  }
  const nocional = num("nocional", 1000);
  const comision = num("comision", 15);   // 0,075% con BNB, ida o vuelta
  const listaRuta = txt("lista");
  const simbolos: string[] = listaRuta && existsSync(listaRuta)
    ? JSON.parse(readFileSync(listaRuta, "utf-8"))
    : ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "INJUSDT"];

  const dir = dirname(ruta);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });

  const ahora = new Date().toISOString();
  const reg: Registro = existsSync(ruta)
    ? JSON.parse(readFileSync(ruta, "utf-8"))
    : { version: 1, inicio: ahora, ultima: ahora, muestras: [] };

  let fallos = 0;
  const nuevas: CosteMedido[] = [];
  for (const s of simbolos) {
    try {
      const m = medirLibro(await libroDe(s), nocional);
      if (m) nuevas.push(m);
      else fallos += 1;
    } catch {
      fallos += 1;
    }
    await dormir(200);
  }
  if (nuevas.length === 0) {
    console.error("Ninguna medida. No se toca el registro.");
    process.exitCode = 1;
    return;
  }

  // SOLO SE AÑADE. Una muestra tomada es un hecho de ese instante y no se puede mejorar despues.
  reg.muestras.push(...nuevas);
  reg.ultima = ahora;
  if (existsSync(ruta)) copyFileSync(ruta, `${ruta}.bak`);
  writeFileSync(ruta, JSON.stringify(reg, null, 2));

  console.log(
    `COSTE REAL · ${nuevas.length} medidas nuevas · ${reg.muestras.length} acumuladas · ` +
      `nocional ${nocional}$ · comision ${comision} pb por lado${fallos ? ` · ${fallos} fallos` : ""}`,
  );
  console.log(
    `desde ${reg.inicio.slice(0, 16)}\n`,
  );
  console.log(
    `${"moneda".padEnd(11)}${"muestras".padStart(9)}${"spread".padStart(9)}` +
      `${"impacto".padStart(9)}${"coste i/v".padStart(11)}${"en estres".padStart(11)}`,
  );
  console.log("-".repeat(62));

  const porSimbolo = new Map<string, CosteMedido[]>();
  for (const m of reg.muestras) {
    porSimbolo.set(m.simbolo, [...(porSimbolo.get(m.simbolo) ?? []), m]);
  }
  const resumenes = [...porSimbolo.values()]
    .map((ms) => resumir(ms, comision))
    .sort((a, b) => a.costeMediano - b.costeMediano);

  for (const r of resumenes) {
    console.log(
      `${r.simbolo.padEnd(11)}${String(r.muestras).padStart(9)}` +
        `${r.spreadMediano.toFixed(2).padStart(8)}pb${r.impactoMediano.toFixed(2).padStart(7)}pb` +
        `${r.costeMediano.toFixed(1).padStart(9)}pb${r.costeP90.toFixed(1).padStart(9)}pb` +
        `${r.algunaMuestraCorta ? "  LIBRO CORTO" : ""}`,
    );
  }

  const supuesto = 10;
  const peores = resumenes.filter((r) => r.costeMediano > supuesto * 2);
  console.log(
    `\nEl backtest usa ${supuesto} pb planos para todas.` +
      (peores.length
        ? ` ${peores.length} monedas cuestan MAS DEL DOBLE: ` +
          `${peores.map((r) => r.simbolo).join(", ")}.`
        : " Ninguna se pasa del doble."),
  );
  if (reg.muestras.length < simbolos.length * 24) {
    console.log(
      "Con menos de un dia de muestras esto es una foto, no una medida: el spread cambia con la\n" +
        "hora y con el panico, y lo que importa es lo que se paga cuando saltan los stops.",
    );
  }
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
