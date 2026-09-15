import { test } from "node:test";
import assert from "node:assert/strict";
import { leerVelas, type VelasDeFichero } from "../src/forex/velasFichero";

const v = (t: number, c: number) => ({ t, o: c, h: c, l: c, c });
const AHORA = 1_000_000;

const datos: VelasDeFichero = {
  fuente: "MT5 XMGlobal-MT5 2",
  desfase: 10800,
  sacadas: "x",
  tf: {
    // A proposito DESORDENADAS: el exportador las da ordenadas, pero todo lo que viene despues
    // recorre el array por indice y daria resultados sin sentido si llegara desordenado.
    "5m": { "USDJPY=X": [v(AHORA - 600, 3), v(AHORA - 1200, 1), v(AHORA - 900, 2)] },
    "15m": { "USDJPY=X": [v(AHORA - 1800, 1)] },
  },
};

test("las ordena por tiempo aunque lleguen revueltas", () => {
  const r = leerVelas(datos, "5m", AHORA);
  assert.deepEqual(r.velas.get("USDJPY=X")!.map((x) => x.c), [1, 2, 3]);
});

test("trae la fuente para que el informe diga con que precios decidio", () => {
  assert.equal(leerVelas(datos, "5m", AHORA).fuente, "MT5 XMGlobal-MT5 2");
});

test("LA ANTIGUEDAD SE MIDE CONTRA EL FINAL DE LA ULTIMA VELA, no contra su principio", () => {
  // La ultima empieza 600s atras y dura 300: termina 300s atras, asi que al dia es 0.
  assert.equal(leerVelas(datos, "5m", AHORA - 300).antiguedad, 0);
  // Diez minutos despues de que cerrara, son 600 de retraso.
  assert.equal(leerVelas(datos, "5m", AHORA + 300).antiguedad, 600);
});

test("UNAS VELAS VIEJAS SE NOTAN: es lo que evita apuntar señales rancias como nuevas", () => {
  assert.ok(leerVelas(datos, "5m", AHORA + 3600).antiguedad > 3000);
});

test("una temporalidad que no esta en el fichero da error, no un mapa vacio", () => {
  // Devolver vacio dejaria al grabador creyendo que no hay señales, que es indistinguible de
  // que de verdad no las haya.
  assert.throws(() => leerVelas(datos, "1h", AHORA), /no trae la temporalidad 1h/);
});

test("un par sin velas no rompe ni aparece", () => {
  const vacio: VelasDeFichero = { ...datos, tf: { "5m": { "USDJPY=X": [], "GBPJPY=X": [v(AHORA, 1)] } } };
  const r = leerVelas(vacio, "5m", AHORA);
  assert.equal(r.velas.has("USDJPY=X"), false);
  assert.equal(r.velas.has("GBPJPY=X"), true);
});

test("UNA VELA DEL FUTURO NO ES FRESCA, es tan invalida como una vieja", () => {
  // El 15 sep el exportador dedujo mal el desfase del servidor y escribio el fichero 20 horas
  // ADELANTADO. Con `Math.max(0, ...)` la antiguedad salia 0, las velas pasaban por frescas y
  // seis registros apuntaron una señal inventada.
  //
  // Una vela fechada en el futuro no es reciente: su fecha simplemente no es la que dice.
  const ahora = 1_000_000;
  const futuro: VelasDeFichero = {
    fuente: "MT5", desfase: 0, sacadas: "x",
    tf: { "5m": { "EURUSD=X": [{ t: ahora + 20 * 3600, o: 1, h: 1, l: 1, c: 1 }] } },
  };
  const r = leerVelas(futuro, "5m", ahora);
  assert.ok(r.antiguedad > 3600, `antiguedad ${r.antiguedad}, deberia ser grande`);
});

test("una vela de ahora sigue contando como fresca", () => {
  // La otra mitad: el arreglo no puede volver rancio lo que esta al dia.
  const ahora = 1_000_000;
  const alDia: VelasDeFichero = {
    fuente: "MT5", desfase: 0, sacadas: "x",
    tf: { "5m": { "EURUSD=X": [{ t: ahora - 300, o: 1, h: 1, l: 1, c: 1 }] } },
  };
  assert.equal(leerVelas(alDia, "5m", ahora).antiguedad, 0);
});
