/**
 * ¿Cuanto coste ABSOLUTO he estado cobrando a cada estrategia?
 *
 *   npm run coste:real -- --cache=V.json --tf=1d
 *
 * Todo el proyecto expresa el coste como fraccion del RIESGO (0,05R). Pero el coste real
 * —comision mas spread— es fijo EN PRECIO, no proporcional al stop que uno elija. Poner un stop
 * mas ancho no hace que Binance cobre mas.
 *
 * Consecuencia: con un mismo 0,05R, una estrategia de stop ancho paga muchisimo mas en dinero
 * real que una de stop estrecho. Esto mide cuanto.
 */
import { readFileSync } from "node:fs";
import type { Vela } from "../forex/datos";
import { atr } from "../forex/multiTf";

function txt(n: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
}

function main(): void {
  const ruta = txt("cache")!;
  const etiqueta = txt("etiqueta") ?? "";
  const multStop = Number(txt("stop") ?? 2);
  const costeR = Number(txt("costeR") ?? 0.05);
  const datos = JSON.parse(readFileSync(ruta, "utf-8")) as Record<string, Vela[]>;

  const fracciones: number[] = [];
  for (const v of Object.values(datos)) {
    if (v.length < 100) continue;
    const a = atr(v, 14);
    for (let i = 20; i < v.length; i += 1) {
      const av = a[i];
      if (av == null || !(av > 0) || !(v[i]!.c > 0)) continue;
      fracciones.push((av * multStop) / v[i]!.c);
    }
  }
  if (!fracciones.length) { console.log(`${etiqueta}: sin datos`); return; }
  fracciones.sort((x, y) => x - y);
  const mediana = fracciones[Math.floor(fracciones.length / 2)]!;

  // Coste absoluto implicito = costeR x stop, expresado en % del precio.
  const absoluto = costeR * mediana;
  console.log(
    `${etiqueta.padEnd(22)}stop ${multStop} ATR = ${(mediana * 100).toFixed(2)}% del precio · ` +
      `coste ${costeR}R = ${(absoluto * 100).toFixed(4)}% del precio (ida y vuelta)`,
  );
}

main();
