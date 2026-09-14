/**
 * Graba el RETROCESO DEL RSI EN TENDENCIA hacia adelante. Sin dinero, sin ordenes, sin exchange.
 *
 *   npx tsx src/tools/grabarPullbackCli.ts --registro=RUTA.json --version=V1|V2 --velas=RUTA.json
 *
 * QUE ES Y POR QUE SE GRABA APARTE
 * --------------------------------
 * Es la estrategia OPUESTA a la de divergencias que ya corre aqui. Aquella es de VUELTA: compra
 * cuando el precio se agota y gira. Esta es de CONTINUACION: compra cuando el precio descansa
 * dentro de una tendencia y sigue. No son variantes de lo mismo y no se mezclan en un registro.
 *
 * Y hay una razon medida para esperar que se complementen. Sobre 244 dias de velas de XM, la de
 * divergencias PIERDE en el solape Londres-NY (13-17h UTC): -0,096R, mientras que el resto del
 * dia le da +0,347R. Esas son las horas mas tendenciales, que es exactamente donde una estrategia
 * de vuelta lo tiene peor y donde una de continuacion deberia tenerlo mejor. El registro dira si
 * eso es asi o si solo suena bien.
 *
 * DOS VERSIONES, QUE ES EL EXPERIMENTO
 * ------------------------------------
 * V1 filtra solo con la tendencia de 15m. V2 añade el marco de 1h, el ADX con sus direccionales,
 * el cuerpo minimo de la vela de confirmacion y la volatilidad relativa.
 *
 * Se graban LAS DOS, en registros separados, sobre los mismos pares y las mismas velas. Los
 * filtros de V2 cuestan operaciones —sobre datos sinteticos quitan mas del 90%— y la unica
 * pregunta que importa es si lo que queda vale mas por operacion de lo que se ha perdido en
 * numero. Eso no se contesta discutiendolo, se contesta comparando dos registros.
 *
 * ENTRADA A MERCADO, y esto cambia como se graba
 * ----------------------------------------------
 * Las divergencias entran con orden LIMITADA: el nivel se conoce antes y se espera a que el
 * precio vuelva. Esta no. Su señal ES el cierre de la vela de confirmacion, y para entonces el
 * precio ya se ha ido; poner ahi una limitada seria quedarse fuera justo de los arranques que la
 * estrategia existe para coger.
 *
 * Asi que el grabador llena en la APERTURA DE LA SIGUIENTE VELA, que es lo que pasaria de verdad:
 * cierra la vela, mandas la orden, te llenan con el siguiente tick. El precio apuntado se guarda
 * igual y no se toca, y el llenado real va aparte, como en todos los demas registros.
 *
 * EL COSTE, MEDIDO EN VIVO EL 14 SEP y no supuesto
 * -----------------------------------------------
 * Mediana del spread con el mercado abierto, 168-176 muestras por par:
 *
 *     EURUSD  2,10 pips = 1,81 pb      EURJPY  3,50 pips = 1,97 pb
 *     GBPUSD  2,50 pips = 1,85 pb      GBPJPY  3,80 pips = 1,83 pb
 *     USDJPY  2,60 pips = 1,69 pb      AUDUSD  2,40 pips = 3,36 pb
 *
 * En pips se parecen poco y en puntos basicos son casi el mismo numero, que es lo que hace que
 * un solo `--costebps` valga para los seis. AUDUSD es el caro de verdad —cotiza a 0,72, asi que
 * los mismos pips pesan el doble— y por eso se apunta aqui en vez de esconderlo en una media.
 *
 * Por defecto 1,9 pb, que es la mediana de los seis. Las muestras son de la sesion asiatica, que
 * es la MAS ancha del dia: en Londres-NY el spread baja, asi que este numero peca de caro, que
 * es el lado por el que conviene equivocarse.
 *
 * SOLO LEE VELAS DE MT5. No hay respaldo de Yahoo a proposito: entre las dos fuentes hay un
 * sesgo constante de 0,8-1,4 pips y esta estrategia se va a ejecutar en XM. Decidir en un libro
 * y ejecutar en otro es el fallo que ya costo una reescritura en este proyecto.
 *
 * EL ESTADO VIVE FUERA DE CUALQUIER CONTENEDOR.
 */
import { readFileSync, existsSync } from "node:fs";
import { guardarRegistro } from "../forex/guardar";
import { leerVelas, grupoDeSimbolos, type VelasDeFichero } from "../forex/velasFichero";
import type { Vela } from "../forex/datos";
import { adx } from "../forex/adx";
import { auditar, informeAuditoria } from "../forex/auditor";
import { deForex } from "../forex/auditables";
import { señalesPullback, V1, V2, type AjustesPullback } from "../forex/pullback";
import {
  registroNuevo, pasada, balance, mismosAjustes, muestraNecesaria,
  VERSION_GRABADOR, type Registro, type Proveedor,
} from "../forex/grabador";

function txt(n: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
}
function num(n: string, d: number): number {
  const m = txt(n);
  if (m === undefined) return d;
  const v = Number(m);
  return Number.isFinite(v) ? v : d;
}

/**
 * LOS SEIS PARES. Son los que pidio la especificacion y los que el medidor de spread cubre.
 *
 * El sufijo `=X` es el vocabulario que habla el resto del proyecto —viene de Yahoo, de cuando
 * los datos salian de ahi— y `velas.py` lo pone tambien a las velas de MT5 para que registros,
 * informes y auditorias sigan entendiendose entre ellos.
 */
const PARES = ["EURUSD=X", "GBPUSD=X", "USDJPY=X", "EURJPY=X", "GBPJPY=X", "AUDUSD=X"];

interface Ajustes {
  /** Dentro de los ajustes para que el grabador se niegue a mezclar V1 y V2 en un registro. */
  version: string;
  /** Y lo mismo con la fuente: velas de Yahoo y de XM no son la misma estrategia. */
  fuente: string;
  pb: AjustesPullback;
}

function main(): void {
  const ruta = txt("registro");
  if (!ruta) {
    console.error("Falta --registro=RUTA.json (ponla FUERA de cualquier contenedor)");
    process.exitCode = 1;
    return;
  }
  const version = (txt("version") ?? "V1").toUpperCase();
  if (version !== "V1" && version !== "V2") {
    console.error("--version tiene que ser V1 o V2");
    process.exitCode = 1;
    return;
  }
  const fichero = txt("velas");
  if (!fichero) {
    console.error(
      "Falta --velas=RUTA.json. Esta estrategia SOLO se graba con velas de MT5: entre Yahoo y\n" +
        "XM hay un sesgo constante de 0,8-1,4 pips, y se va a ejecutar en XM. Lo escribe\n" +
        "src/mt5/velas.py y tiene que traer las temporalidades 5m, 15m y 1h.",
    );
    process.exitCode = 1;
    return;
  }
  if (!existsSync(fichero)) {
    console.error(`No existe el fichero de velas ${fichero}. Lo escribe src/mt5/velas.py.`);
    process.exitCode = 1;
    return;
  }

  const ahora = new Date().toISOString();
  const crudo = JSON.parse(readFileSync(fichero, "utf-8")) as VelasDeFichero;
  const pares = (txt("pares") ?? PARES.join(",")).split(",").filter(Boolean);
  const costeBps = num("costebps", 1.9);
  const base = version === "V2" ? V2 : V1;
  // EL GRUPO DE SIMBOLOS VA DENTRO DE LA FUENTE. En esta cuenta conviven `EURUSD` (Standard,
  // 2,20 pips) y `EURUSD#` (Ultra Low, 1,30); las velas son BID, asi que las dos series difieren
  // medio pip de forma constante. Metido aqui, el grabador se niega a continuar un registro
  // empezado con el otro grupo en vez de mezclarlos en silencio.
  const grupo = grupoDeSimbolos(crudo);
  // Se pueden pedir por linea de comandos TRES parametros, y nada mas. Cada uno abierto es una
  // variante que alguien puede cambiar a mitad de un registro sin darse cuenta; el grabador lo
  // detectaria y se negaria a seguir, pero mejor que ni haya ocasion. El resto sale de
  // `pullback.ts`, escrito y probado.
  //
  // `adxsubiendo` esta abierto porque es, con diferencia, el filtro mas caro de V2: medido el
  // 14 sep sobre 31 dias de velas de XM y los seis pares, encenderlo solo sobre V1 baja de 3,80
  // a 0,45 operaciones al dia. V2 entera se queda en 0,16/dia — cinco señales en un mes, que no
  // llegan a muestra ni dejandolo un año. Poder aflojar ESE es lo que hace medible a V2.
  const pb: AjustesPullback = {
    ...base,
    adxMinimo: num("adx", base.adxMinimo),
    adxSubiendoDesde: num("adxsubiendo", base.adxSubiendoDesde),
    objetivoR: num("objetivor", base.objetivoR),
  };
  // LA ETIQUETA SE DEDUCE DE LO QUE DE VERDAD CAMBIO, en vez de escribirla a mano. Dos registros
  // llamados los dos "V2" con parametros distintos serian la forma mas facil de comparar dos
  // cosas creyendo que son la misma; el grabador no los mezclaria —compara los ajustes enteros—
  // pero el informe si los llamaria igual, y eso se lee y se cree.
  const cambios = (["adxMinimo", "adxSubiendoDesde", "objetivoR"] as const)
    .filter((k) => pb[k] !== base[k])
    .map((k) => `${k}=${pb[k]}`);
  const ajustes: Ajustes = {
    version: cambios.length ? `${version}(${cambios.join(",")})` : version,
    fuente: grupo ? `MT5 ${grupo}` : "MT5",
    pb,
  };

  let reg: Registro<Ajustes>;
  if (existsSync(ruta)) {
    reg = JSON.parse(readFileSync(ruta, "utf-8")) as Registro<Ajustes>;
    if (reg.version !== VERSION_GRABADOR) {
      console.error(`El registro es version ${reg.version} y este grabador es ${VERSION_GRABADOR}.`);
      process.exitCode = 1;
      return;
    }
    if (!mismosAjustes(reg.ajustes, ajustes) || reg.costeBps !== costeBps) {
      console.error(
        "LOS AJUSTES NO COINCIDEN con los del registro. Cambiarlos a mitad invalida la\n" +
          "comparacion entera: lo grabado hasta ahora seria de otra estrategia. Si de verdad\n" +
          "quieres otros ajustes, empieza un registro nuevo en otro fichero.",
      );
      process.exitCode = 1;
      return;
    }
  } else {
    // VIGENCIA 1: a mercado se entra en la vela SIGUIENTE a la señal o no se entra.
    //
    // Y eso resuelve solo el caso del fin de semana. Si la señal cae el viernes al cierre, la
    // siguiente vela del fichero es la del domingo: su `t` ya pasa de `caducaEn`, asi que la
    // señal caduca en vez de llenarse en el hueco de la reapertura. Que es lo correcto —esa
    // orden no habria sobrevivido el fin de semana— y sale gratis.
    reg = registroNuevo("pullback", ahora, ajustes, costeBps, 1);
    console.log(`Registro nuevo en ${ruta}\n`);
  }

  // ---- Las velas, las tres temporalidades del mismo fichero ---------------------------------
  const ahoraSeg = Math.floor(Date.parse(ahora) / 1000);
  let men;
  let may;
  let mac;
  try {
    men = leerVelas(crudo, "5m", ahoraSeg);
    may = leerVelas(crudo, "15m", ahoraSeg);
    mac = leerVelas(crudo, "1h", ahoraSeg);
  } catch (e) {
    console.error(
      `${e instanceof Error ? e.message : String(e)}\n` +
        "Esta estrategia necesita 5m, 15m y 1h. Añade --tf=5m,15m,1h a la llamada de velas.py.",
    );
    process.exitCode = 1;
    return;
  }

  // UNAS VELAS RANCIAS NO FALLAN, CONTAMINAN: el grabador apuntaria señales viejas como si
  // fueran de ahora y el registro dejaria de ser una prueba hacia adelante sin que nada avise.
  if (men.antiguedad > 300) {
    // EL MERCADO CERRADO NO ES UN FALLO. Se distingue por el TAMAÑO del retraso: horas es el
    // fin de semana; minutos es que el exportador dejo de correr, y eso si hay que verlo.
    if (men.antiguedad > 3 * 3600) {
      console.log(
        `Mercado cerrado: la ultima vela tiene ${(men.antiguedad / 3600).toFixed(1)} h. ` +
          "No hay nada que apuntar.",
      );
      return;
    }
    console.error(
      `Las velas de ${fichero} tienen ${Math.round(men.antiguedad / 60)} min de retraso.\n` +
        "No se toca el registro: apuntar con velas viejas lo convierte en un backtest.",
    );
    process.exitCode = 1;
    return;
  }

  const menores = new Map<string, Vela[]>();
  const mayores = new Map<string, Vela[]>();
  const macros = new Map<string, Vela[]>();
  const faltan: string[] = [];
  // La EMA de 200 sobre 1h necesita 200 velas antes de dar el primer valor, y V2 no opera hasta
  // tenerla. Se exige aqui para que la falta salga como un aviso y no como un registro que no
  // apunta nada sin decir por que.
  const minMacro = ajustes.pb.usarMacro ? ajustes.pb.emaLenta + 20 : 0;
  for (const p of pares) {
    const vm = men.velas.get(p);
    const vM = may.velas.get(p);
    const vH = mac.velas.get(p);
    if (vm && vM && vm.length > 300 && vM.length > 250 && (vH?.length ?? 0) >= minMacro) {
      menores.set(p, vm);
      mayores.set(p, vM);
      macros.set(p, vH ?? []);
    } else {
      faltan.push(`${p} (5m ${vm?.length ?? 0}, 15m ${vM?.length ?? 0}, 1h ${vH?.length ?? 0})`);
    }
  }
  if (faltan.length) console.error(`Sin velas suficientes: ${faltan.join(", ")}`);
  if (menores.size < pares.length / 2) {
    console.error(`Solo ${menores.size} de ${pares.length} pares con velas. No se toca el registro.`);
    process.exitCode = 1;
    return;
  }

  // El grabador recorre la temporalidad MENOR, que es donde se entra. Las otras dos entran por
  // la clausura; `señalesPullback` ya se encarga de no usar una vela mayor antes de que cierre.
  const proveedor: Proveedor = (par, velas5) => {
    const m15 = mayores.get(par);
    if (!m15) return [];
    return señalesPullback(m15, velas5, macros.get(par) ?? [], ajustes.pb)
      .map((s) => ({
        i: s.i, direccion: s.direccion, entrada: s.entrada, stop: s.stop,
        objetivo: s.objetivo, rr: s.rr, tipo: "MERCADO" as const,
      }));
  };

  // EL ADX DE 15m EN EL INSTANTE DEL LLENADO, apuntado en cada operacion que se abra.
  //
  // No filtra nada: la estrategia grabada es exactamente la que dicen los ajustes. Es una MEDIDA
  // guardada para poder contestar despues, sobre el registro vivo, la pregunta que separa V1 de
  // V2 sin gastar una muestra nueva: ¿las entradas de V1 con ADX alto van mejor que las de ADX
  // bajo? Si la respuesta es que no, el filtro de V2 esta cobrando operaciones y no da nada.
  //
  // Es la misma idea que el RSI-50 del registro de divergencias, y por el mismo motivo: cambiar
  // los ajustes invalidaria el registro, apuntar un numero no.
  const adxMayores = new Map<string, (number | null)[]>();
  for (const [par, may2] of mayores) adxMayores.set(par, adx(may2, 14).adx);
  const marcador = (par: string, tEntrada: number): number | undefined => {
    const may2 = mayores.get(par);
    const xs = adxMayores.get(par);
    if (!may2 || !xs) return undefined;
    // La ultima vela de 15m CERRADA antes de la entrada. La que esta en curso no se conoce.
    let j = -1;
    for (let k = 0; k + 1 < may2.length; k += 1) {
      if (may2[k + 1]!.t <= tEntrada) j = k;
      else break;
    }
    return j >= 0 ? xs[j] ?? undefined : undefined;
  };

  const arranque = reg.pasadas === 0;
  const { registro, resumen } = pasada(reg, menores, proveedor, ahora, marcador);
  guardarRegistro(ruta, registro);

  // ---- Informe ------------------------------------------------------------------------------
  console.log(
    `GRABADOR RETROCESO ${ajustes.version} · pasada ${registro.pasadas} · ${ahora.slice(0, 16)}`,
  );
  // El informe se describe desde los AJUSTES, no desde una cadena escrita a mano: cuando se
  // añadio un modo al grabador de divergencias, el texto a mano siguio describiendo el anterior.
  const a = ajustes.pb;
  console.log(
    `${menores.size} pares · tendencia en 15m${a.usarMacro ? " + 1h" : ""} · ` +
      `entrada a mercado en 5m · RSI ${a.periodoRsi} zona ${a.zonaBaja}-${a.zonaAlta} ` +
      `gatillo ${a.gatillo} · stop swing ${a.velasSwing} + ${a.colchonAtr} ATR ` +
      `(max ${a.maxStopAtr} ATR) · objetivo ${a.objetivoR}R · coste ${costeBps} pb` +
      // CADA TROZO SALE DE SU PROPIO PARAMETRO. Antes esta linea decia "ADX>20 subiendo" en
      // cuanto la version fuera V2, tambien con la exigencia de subir apagada. Un informe que
      // describe mal lo que hace es peor que no tenerlo: se lee y se cree.
      (a.adxMinimo > 0 ? ` · ADX>${a.adxMinimo}` : "") +
      (a.adxSubiendoDesde > 0 ? ` subiendo en ${a.adxSubiendoDesde} velas` : "") +
      (a.cuerpoMinimoAtr > 0 ? ` · cuerpo>=${a.cuerpoMinimoAtr} ATR` : "") +
      (a.atrRelativoMin > 0 || a.atrRelativoMax < 99
        ? ` · ATR rel ${a.atrRelativoMin}-${a.atrRelativoMax}`
        : ""),
  );
  if (arranque) {
    console.log(
      "\nPRIMERA PASADA: solo se marca por donde va cada par, sin apuntar nada.\n" +
        "El registro cuenta desde ahora hacia adelante, que es lo unico que no se puede\n" +
        "contaminar. A partir de la proxima pasada empieza a apuntar señales.",
    );
  } else {
    console.log(
      `\n${resumen.nuevas} señal(es) nueva(s) · ${resumen.abiertas} abierta(s) · ` +
        `${resumen.cerradas} cerrada(s) · ${resumen.caducadas} caducada(s)`,
    );
  }

  for (const [etq, lista] of [
    ["Esperando la apertura siguiente", registro.pendientes],
    ["Abiertas", registro.abiertas],
  ] as const) {
    if (!lista.length) continue;
    console.log(`\n${etq} (${lista.length}):`);
    for (const p of lista.slice(0, 8)) {
      console.log(
        `  ${p.par.padEnd(10)}${p.direccion.padEnd(7)}entrada ${p.entrada.toFixed(5)} · ` +
          `stop ${p.stop.toFixed(5)} · objetivo ${p.objetivo.toFixed(5)} · ${p.rr.toFixed(1)}R`,
      );
    }
  }

  const b = balance(registro.cerradas);
  if (b.n > 0) {
    const hacenFalta = muestraNecesaria(b);
    console.log(
      `\nCERRADAS: ${b.n} · acierto ${(b.aciertos * 100).toFixed(0)}% · ` +
        `R:R medio ${b.rrMedio.toFixed(1)} · PF ${b.pf.toFixed(2)} · ` +
        `${b.esperanza.toFixed(3)}R ±${b.error.toFixed(3)}`,
    );
    console.log(
      Number.isFinite(hacenFalta)
        ? `Para distinguir esa esperanza del cero harian falta ~${hacenFalta.toLocaleString("es")}` +
          ` operaciones. Llevas ${b.n}.`
        : "Aun no hay con que estimar nada.",
    );
    // LA LINEA QUE VALE ES LA ESTRICTA: las apuntadas cuando su entrada aun no habia ocurrido.
    // Con entrada a mercado esto pesa mas que en los otros registros, porque el llenado es la
    // apertura de la vela siguiente: si el grabador va tarde, esa apertura ya se conocia.
    const estrictas = registro.cerradas.filter((c) => c.velasDeRetraso === 0);
    const be = balance(estrictas);
    console.log(
      be.n > 0
        ? `   ESTRICTAS: ${be.n} · acierto ${(be.aciertos * 100).toFixed(0)}% · ` +
          `PF ${be.pf.toFixed(2)} · ${be.esperanza.toFixed(3)}R ±${be.error.toFixed(3)}`
        : "   ESTRICTAS: 0. TODAS se apuntaron con velas posteriores ya cerradas, asi que de " +
          "momento esto no es una prueba hacia adelante sino un backtest con retraso.",
    );

    // LAS HORAS, que es la hipotesis con la que nace este registro. La de divergencias pierde
    // en el solape Londres-NY (-0,096R) y gana fuera (+0,347R); si esta es de continuacion de
    // verdad, tendria que ir al reves. Se imprime desde el principio aunque no diga nada
    // todavia: es la pregunta, y conviene tenerla delante y no en una nota aparte.
    const solape = registro.cerradas.filter((c) => {
      const h = new Date(c.tEntrada * 1000).getUTCHours();
      return h >= 13 && h < 17;
    });
    const fuera = registro.cerradas.filter((c) => !solape.includes(c));
    const bs = balance(solape);
    const bf = balance(fuera);
    console.log(
      `   POR HORA · solape LON-NY (13-17h UTC): ${bs.n} · ${bs.esperanza.toFixed(3)}R ` +
        `±${bs.error.toFixed(3)}\n` +
        `              el resto del dia:          ${bf.n} · ${bf.esperanza.toFixed(3)}R ` +
        `±${bf.error.toFixed(3)}`,
    );

    // Y EL ADX MARCADO, que es la comparacion V1 contra V2 hecha dentro de un solo registro.
    const marcadas = registro.cerradas.filter((c) => c.marca != null);
    if (marcadas.length >= 10) {
      const fuerte = marcadas.filter((c) => c.marca! > 20);
      const flojo = marcadas.filter((c) => c.marca! <= 20);
      const bfu = balance(fuerte);
      const bfl = balance(flojo);
      console.log(
        `   ADX AL LLENARSE (${marcadas.length} de ${b.n} con marca):\n` +
          `      por encima de 20: ${bfu.n} · ${bfu.esperanza.toFixed(3)}R ±${bfu.error.toFixed(3)}\n` +
          `      por debajo:       ${bfl.n} · ${bfl.esperanza.toFixed(3)}R ±${bfl.error.toFixed(3)}`,
      );
    }
    if (b.n < 100) {
      console.log("Con menos de 100 cerradas este numero es ruido. No decidas nada con el.");
    }
  }

  // ---- LA AUDITORIA, sobre TODO lo cerrado y no solo lo de hoy -------------------------------
  const auditoria = auditar(registro.cerradas.map(deForex), (p) => menores.get(p));
  console.log(informeAuditoria(auditoria));
  if (auditoria.anomalias.length > 0) {
    console.error(
      "HAY OPERACIONES IMPOSIBLES EN EL REGISTRO. No es una advertencia de estilo: alguno de " +
        "los precios de arriba no existio nunca, asi que el resultado que salga de aqui no vale.",
    );
    process.exitCode = 1;
  }

  console.log(`\nGuardado en ${ruta}. No se ha enviado ninguna orden a ningun sitio.`);
}

try {
  main();
} catch (e) {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
