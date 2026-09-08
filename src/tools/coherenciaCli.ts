/**
 * ¿Cuadra la vela DIARIA de Yahoo con sus propias velas HORARIAS?
 *
 *   npm run coherencia -- --diario=d.json --horario=h.json --lista=l.json [--etiqueta=cripto]
 *
 * POR QUE ESTA PRUEBA
 * -------------------
 * Comparando cripto contra Binance salio que el rango diario de Yahoo es MAS ESTRECHO que el
 * real en el 99% de los dias, y eso hace que los stops salten de menos y el backtest salga
 * optimista.
 *
 * Para saber si le pasa lo mismo a forex y a los ETFs no hace falta otra fuente: basta con
 * comprobar la coherencia interna. El maximo del dia tiene que ser el mayor de los maximos de
 * sus horas. Si el diario se queda corto, la propia fuente se contradice.
 *
 * AVISO: en instrumentos con sesion (ETFs, futuros) el diario cubre mas horas que las velas
 * horarias que sirve Yahoo, asi que ahi es NORMAL que el diario sea mas ancho. Lo que delata el
 * defecto es el caso contrario: diario MAS ESTRECHO que sus propias horas.
 */
import { readFileSync, existsSync } from "node:fs";
import type { Vela } from "../forex/datos";

function txt(n: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
}
const dia = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10);

function main(): void {
  const rutaD = txt("diario");
  const rutaH = txt("horario");
  const etiqueta = txt("etiqueta") ?? "";
  if (!rutaD || !rutaH || !existsSync(rutaD) || !existsSync(rutaH)) {
    console.error("Faltan --diario y --horario");
    process.exitCode = 1;
    return;
  }
  const diarios = JSON.parse(readFileSync(rutaD, "utf-8")) as Record<string, Vela[]>;
  const horarios = JSON.parse(readFileSync(rutaH, "utf-8")) as Record<string, Vela[]>;

  console.log(`\n### ${etiqueta} ###`);
  console.log(
    `${"activo".padEnd(14)}${"dias".padStart(7)}${"D estrecho".padStart(12)}` +
      `${"D ancho".padStart(10)}${"max perdido".padStart(13)}${"min perdido".padStart(13)}`,
  );
  console.log("-".repeat(69));

  let totalEstrecho = 0;
  let totalDias = 0;
  for (const [s, vd] of Object.entries(diarios)) {
    const vh = horarios[s];
    if (!vh || vh.length === 0) continue;

    // Maximo y minimo reconstruidos de las horas de cada dia.
    const porDia = new Map<string, { h: number; l: number }>();
    for (const v of vh) {
      const d = dia(v.t);
      const a = porDia.get(d);
      if (a) {
        a.h = Math.max(a.h, v.h);
        a.l = Math.min(a.l, v.l);
      } else porDia.set(d, { h: v.h, l: v.l });
    }

    let estrecho = 0;
    let ancho = 0;
    let sumaMax = 0;
    let sumaMin = 0;
    let n = 0;
    for (const v of vd) {
      const r = porDia.get(dia(v.t));
      if (!r || !(v.h > 0) || !(v.l > 0)) continue;
      n += 1;
      // Cuanto se queda corto el diario respecto a sus propias horas, en fraccion del precio.
      const faltaMax = Math.max(0, r.h - v.h) / v.c;
      const faltaMin = Math.max(0, v.l - r.l) / v.c;
      sumaMax += faltaMax;
      sumaMin += faltaMin;
      const rangoD = v.h - v.l;
      const rangoH = r.h - r.l;
      if (rangoD < rangoH * 0.999) estrecho += 1;
      else if (rangoD > rangoH * 1.001) ancho += 1;
    }
    if (n < 30) continue;
    totalEstrecho += estrecho;
    totalDias += n;
    console.log(
      `${s.padEnd(14)}${String(n).padStart(7)}` +
        `${`${((estrecho / n) * 100).toFixed(0)}%`.padStart(12)}` +
        `${`${((ancho / n) * 100).toFixed(0)}%`.padStart(10)}` +
        `${`${((sumaMax / n) * 100).toFixed(3)}%`.padStart(13)}` +
        `${`${((sumaMin / n) * 100).toFixed(3)}%`.padStart(13)}`,
    );
  }
  if (totalDias > 0) {
    console.log(
      `\n  El diario se queda MAS ESTRECHO que sus propias horas en el ` +
        `${((totalEstrecho / totalDias) * 100).toFixed(0)}% de los dias.`,
    );
  }
}

main();
