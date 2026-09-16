"""
Las invariantes del ejecutor, probadas sin terminal y sin mercado abierto.

    python -m unittest discover -s src/mt5 -p "test_*.py"

Lo que se prueba aqui NO es que MT5 acepte la orden —eso solo se sabe mandandola— sino las
decisiones que se toman ANTES de mandarla, que son las que pueden arruinar una cuenta en
silencio: cuantos lotes, cuanta exposicion, y si una señal ya puesta se vuelve a poner.
"""
import unittest

from ejecutor import (
    divisas, exposicion_divisas, identidad, limitada_valida, lote, mercado_valido, nocional,
    peaje, perdida_del_dia, que_hacer, riesgo_hueco, senal_fresca, simbolo_broker,
    desfase_reloj, reloj_del_mercado, tick_utilizable,
)
from simbolos import operables_de

# Los de la cuenta de verdad, leidos del terminal el 12 sep: XM, cruces JPY, 3 decimales.
TICK_SIZE = 0.001
TICK_VALUE = 0.6513597134017262
PASO, MINIMO, MAXIMO = 0.01, 0.01, 50.0


class Lotes(unittest.TestCase):
    def test_cuadra_con_la_calculadora_de_mt5(self):
        # MT5 dice que un stop de 9 pips con 0,01 lotes pierde 0,59. Arriesgando 5,00 tocan 0,08.
        v, motivo = lote(5.0, 0.09, TICK_SIZE, TICK_VALUE, PASO, MINIMO, MAXIMO)
        self.assertEqual(v, 0.08)
        self.assertEqual(motivo, "")
        self.assertLessEqual(v * (0.09 / TICK_SIZE) * TICK_VALUE, 5.0)

    def test_REDONDEA_HACIA_ABAJO_SIEMPRE(self):
        # Pasarse del riesgo pedido no es un redondeo: es otra apuesta. Quedarse corto solo mide
        # un poco menos.
        for riesgo in [1.0, 2.5, 5.0, 7.3, 11.9, 50.0]:
            v, _ = lote(riesgo, 0.09, TICK_SIZE, TICK_VALUE, PASO, MINIMO, MAXIMO)
            perdida = v * (0.09 / TICK_SIZE) * TICK_VALUE
            self.assertLessEqual(perdida, riesgo + 1e-9, f"con riesgo {riesgo} se pasa")

    def test_POR_DEBAJO_DEL_MINIMO_NO_OPERA_Y_DICE_CUANTO_SERIA(self):
        # EL FALLO CARO: subir al minimo del broker "porque si no, no entra". Con un stop de
        # 7 pips y 0,50 de riesgo, el minimo arriesga casi el doble. Se niega y lo dice.
        v, motivo = lote(0.30, 0.07, TICK_SIZE, TICK_VALUE, PASO, MINIMO, MAXIMO)
        self.assertEqual(v, 0.0)
        self.assertIn("minimo", motivo)
        self.assertIn("0.46", motivo)

    def test_no_pasa_del_maximo_del_broker(self):
        v, motivo = lote(1_000_000.0, 0.09, TICK_SIZE, TICK_VALUE, PASO, MINIMO, MAXIMO)
        self.assertEqual(v, MAXIMO)
        self.assertIn("maximo", motivo)

    def test_datos_imposibles_no_dan_lote(self):
        for args in [(5.0, 0.0), (5.0, -0.09)]:
            v, motivo = lote(args[0], args[1], TICK_SIZE, TICK_VALUE, PASO, MINIMO, MAXIMO)
            self.assertEqual(v, 0.0)
            self.assertEqual(motivo, "datos invalidos")
        self.assertEqual(lote(5.0, 0.09, 0.0, TICK_VALUE, PASO, MINIMO, MAXIMO)[0], 0.0)
        self.assertEqual(lote(5.0, 0.09, TICK_SIZE, 0.0, PASO, MINIMO, MAXIMO)[0], 0.0)


class Exposicion(unittest.TestCase):
    def test_EL_STOP_ESTRECHO_ESCONDE_APALANCAMIENTO(self):
        # 5 de riesgo con un stop de 9 pips en USDJPY a 153 son 8.500 de exposicion. Sobre una
        # cuenta de 1.000 eso son 8,5x, y con 1:1000 el broker no dice nada. Por eso se mira.
        exp = nocional(153.0, 5.0, 0.09)
        self.assertAlmostEqual(exp, 8500.0, delta=10)
        self.assertGreater(exp / 1000.0, 8)

    def test_el_mismo_riesgo_con_stop_ancho_expone_menos(self):
        estrecho = nocional(153.0, 5.0, 0.07)
        ancho = nocional(153.0, 5.0, 0.21)
        self.assertAlmostEqual(estrecho / ancho, 3.0, places=6)

    def test_sin_riesgo_no_hay_exposicion(self):
        self.assertEqual(nocional(153.0, 5.0, 0.0), 0.0)


class RiesgoEnHueco(unittest.TestCase):
    def test_EL_HUECO_MULTIPLICA_LA_PERDIDA_PEDIDA(self):
        # El peor hueco medido son 34 pips. Contra un stop de 9, la perdida no son 5 sino 19.
        self.assertAlmostEqual(riesgo_hueco(5.0, 9.0, 34.0), 5.0 * 34 / 9)
        self.assertGreater(riesgo_hueco(5.0, 9.0, 34.0), 18.0)

    def test_un_stop_mas_ancho_que_el_hueco_no_da_sorpresa(self):
        # Con stop de 50 pips y hueco de 34 se pierde lo previsto, ni un centimo mas.
        self.assertEqual(riesgo_hueco(5.0, 50.0, 34.0), 5.0)

    def test_EL_STOP_ESTRECHO_ES_EL_PELIGRO_NO_EL_NOCIONAL(self):
        # Dos operaciones con el MISMO riesgo pedido y el mismo nocional aproximado, pero una
        # con stop de 2 pips: en un hueco cuesta ocho veces mas que la de 16.
        estrecho = riesgo_hueco(5.0, 2.0, 34.0)
        ancho = riesgo_hueco(5.0, 16.0, 34.0)
        self.assertAlmostEqual(estrecho / ancho, 8.0)

    def test_cuatro_posiciones_en_el_peor_hueco_caben_en_el_tope(self):
        # El tope por defecto es el 15% del saldo. Cuatro posiciones de 5 con stop de 9 pips
        # cuestan 75,6 sobre 1.000 = 7,6%: caben. Ocho no.
        una = riesgo_hueco(5.0, 9.0, 34.0)
        self.assertLess(4 * una, 1000 * 0.15)
        self.assertGreater(8 * una, 1000 * 0.15)

    def test_NINGUNA_SOLA_SE_LLEVA_MAS_QUE_SU_PARTE(self):
        # Con un presupuesto del 15% sobre 1.000 y tope de 4 posiciones, a cada una le tocan
        # 37,50. Una con stop de 9 pips cabe (18,89); una con stop de 2 pips no (85,00), y sin
        # esta guarda pasaria solo por llegar la primera, cuando la suma aun estaba a cero.
        suya = 1000 * 0.15 / 4
        self.assertLess(riesgo_hueco(5.0, 9.0, 34.0), suya)
        self.assertGreater(riesgo_hueco(5.0, 2.0, 34.0), suya)

    def test_sin_stop_no_se_inventa_nada(self):
        self.assertEqual(riesgo_hueco(5.0, 0.0, 34.0), 5.0)


class LimitadaValida(unittest.TestCase):
    # Mercado en 153,000 / 153,020 (bid/ask).
    BID, ASK = 153.000, 153.020

    def test_una_compra_limitada_va_por_debajo_del_mercado(self):
        vale, _ = limitada_valida("LARGO", 152.900, self.BID, self.ASK)
        self.assertTrue(vale)

    def test_EL_PRECIO_YA_SE_PASO_hacia_abajo(self):
        # Comprar a 153,10 cuando piden 153,02 no es una limitada: el broker la rechaza con
        # 10015 y, sin esta comprobacion, se reintentaria cada 5 minutos durante 5 horas.
        vale, porque = limitada_valida("LARGO", 153.100, self.BID, self.ASK)
        self.assertFalse(vale)
        self.assertIn("ya cayo", porque)

    def test_una_venta_limitada_va_por_encima(self):
        vale, _ = limitada_valida("CORTO", 153.100, self.BID, self.ASK)
        self.assertTrue(vale)

    def test_EL_PRECIO_YA_SE_PASO_hacia_arriba(self):
        vale, porque = limitada_valida("CORTO", 152.900, self.BID, self.ASK)
        self.assertFalse(vale)
        self.assertIn("ya subio", porque)

    def test_justo_en_el_precio_no_vale(self):
        # Pegado al mercado tampoco es una limitada, y el broker lo trata igual.
        self.assertFalse(limitada_valida("LARGO", self.ASK, self.BID, self.ASK)[0])
        self.assertFalse(limitada_valida("CORTO", self.BID, self.BID, self.ASK)[0])

    def test_sin_cotizacion_no_se_adivina(self):
        self.assertFalse(limitada_valida("LARGO", 152.9, 0, 0)[0])


class Correlacion(unittest.TestCase):
    def test_un_par_son_dos_apuestas(self):
        self.assertEqual(divisas("USDJPY=X"), ("USD", "JPY"))
        self.assertEqual(divisas("GBPJPY"), ("GBP", "JPY"))

    def test_CUATRO_CRUCES_DEL_YEN_SON_LA_MISMA_APUESTA(self):
        # Lo que esta guarda existe para ver: el tope de posiciones cuenta cuatro operaciones
        # distintas, pero en divisas son 10,00 de riesgo contra el yen, todo al mismo lado.
        pos = [(p, "LARGO", 2.5) for p in ("USDJPY", "GBPJPY", "EURJPY", "AUDJPY")]
        neto = exposicion_divisas(pos)
        self.assertAlmostEqual(neto["JPY"], -10.0)
        for d in ("USD", "GBP", "EUR", "AUD"):
            self.assertAlmostEqual(neto[d], 2.5)

    def test_posiciones_opuestas_se_cancelan_en_la_divisa_comun(self):
        # Largo USDJPY y corto GBPJPY: el yen queda plano, y lo que queda es USD contra GBP.
        neto = exposicion_divisas([("USDJPY", "LARGO", 2.5), ("GBPJPY", "CORTO", 2.5)])
        self.assertAlmostEqual(neto["JPY"], 0.0)
        self.assertAlmostEqual(neto["USD"], 2.5)
        self.assertAlmostEqual(neto["GBP"], -2.5)

    def test_sin_posiciones_no_hay_exposicion(self):
        self.assertEqual(exposicion_divisas([]), {})


class Peaje(unittest.TestCase):
    def test_EL_MISMO_SPREAD_ES_BARATO_O_RUINOSO_SEGUN_EL_STOP(self):
        # 1,5 pips contra un stop de 40 es el 4%; contra uno de 1,8 —los de `video`— es el 83%.
        self.assertAlmostEqual(peaje(1.5, 40.0), 0.0375)
        self.assertGreater(peaje(1.5, 1.8), 0.8)

    def test_contra_nuestros_stops_reales(self):
        # Con los 9 pips de `afinado` un spread de 1,5 se lleva el 17% del riesgo.
        self.assertAlmostEqual(peaje(1.5, 9.0), 1.5 / 9.0)

    def test_sin_stop_el_peaje_es_todo(self):
        self.assertEqual(peaje(1.5, 0.0), 1.0)


def pend(par, t, caduca):
    return {"par": par, "tSeñal": t, "caducaEn": caduca, "direccion": "LARGO",
            "entrada": 150.0, "stop": 149.9, "objetivo": 150.15}


class QueHacer(unittest.TestCase):
    AHORA = 1_000_000

    def test_una_señal_ya_puesta_NO_se_vuelve_a_poner(self):
        # La tarea corre cada 15 minutos sobre el mismo registro. Sin esto, la misma señal
        # entraria una vez por pasada hasta caducar.
        p = pend("USDJPY=X", 900_000, self.AHORA + 3600)
        poner, saltar = que_hacer([p], {"USDJPY:900000"}, self.AHORA, 4, 0)
        self.assertEqual(poner, [])
        self.assertEqual(saltar[0][1], "ya estaba puesta")

    def test_una_caducada_no_se_pone(self):
        p = pend("USDJPY=X", 900_000, self.AHORA - 1)
        poner, saltar = que_hacer([p], set(), self.AHORA, 4, 0)
        self.assertEqual(poner, [])
        self.assertIn("caducada", saltar[0][1])

    def test_EL_TOPE_CUENTA_LO_QUE_YA_ESTA_ABIERTO(self):
        # Con 3 posiciones vivas y tope 4 solo cabe una mas, aunque lleguen cinco señales.
        ps = [pend("USDJPY=X", 900_000 + i, self.AHORA + 3600) for i in range(5)]
        poner, saltar = que_hacer(ps, set(), self.AHORA, 4, 3)
        self.assertEqual(len(poner), 1)
        self.assertEqual(len(saltar), 4)
        self.assertTrue(all("tope" in m for _, m in saltar))

    def test_con_el_cupo_lleno_no_se_pone_nada(self):
        ps = [pend("USDJPY=X", 900_000 + i, self.AHORA + 3600) for i in range(3)]
        poner, _ = que_hacer(ps, set(), self.AHORA, 4, 4)
        self.assertEqual(poner, [])

    def test_TODO_LO_DESCARTADO_LLEVA_MOTIVO(self):
        # Un ejecutor que descarta en silencio no se puede auditar despues.
        ps = [pend("USDJPY=X", 1, self.AHORA - 1), pend("GBPJPY=X", 2, self.AHORA + 10)]
        poner, saltar = que_hacer(ps, {"GBPJPY:2"}, self.AHORA, 4, 0)
        self.assertEqual(len(poner) + len(saltar), len(ps))
        self.assertTrue(all(m for _, m in saltar))


class PerdidaDiaria(unittest.TestCase):
    HIST = [
        {"dia": "2026-09-14", "beneficio": -3.0},
        {"dia": "2026-09-14", "beneficio": 1.0},
        {"dia": "2026-09-13", "beneficio": -50.0},
    ]

    def test_solo_cuenta_hoy(self):
        # Los -50 de ayer no pueden bloquear hoy: la guarda es diaria.
        self.assertAlmostEqual(perdida_del_dia(self.HIST, "2026-09-14"), 2.0)

    def test_un_dia_en_verde_da_perdida_negativa(self):
        self.assertAlmostEqual(perdida_del_dia([{"dia": "x", "beneficio": 7.0}], "x"), -7.0)

    def test_sin_historial_no_hay_perdida(self):
        self.assertEqual(perdida_del_dia([], "2026-09-14"), 0.0)


class Simbolos(unittest.TestCase):
    """
    La eleccion de simbolo, que el 14 sep dejo de ser trivial.

    En la cuenta nueva conviven `EURUSD` (grupo Standard, DESACTIVADO, 2,20 pips de spread) y
    `EURUSD#` (Ultra Low, operable, 1,30). Elegir mal no da error: da el doble de coste sobre un
    simbolo al que el broker no deja mandar ordenes.
    """

    def test_nombre_exacto(self):
        self.assertEqual(simbolo_broker("USDJPY=X", {"USDJPY", "EURUSD"}), "USDJPY")

    def test_brokers_que_ponen_sufijo(self):
        self.assertEqual(simbolo_broker("USDJPY=X", {"USDJPYm", "EURUSDm"}), "USDJPYm")

    def test_si_el_broker_no_lo_tiene_devuelve_None(self):
        # Mejor None que adivinar: operar otro par por parecerse el nombre es peor que no operar.
        self.assertIsNone(simbolo_broker("CADJPY=X", {"USDJPY", "EURUSD"}))

    def test_gana_el_operable_aunque_el_pelado_exista(self):
        todos = {"EURUSD", "EURUSD#"}
        self.assertEqual(simbolo_broker("EURUSD=X", todos, {"EURUSD#"}), "EURUSD#")

    def test_sin_lista_de_operables_se_porta_como_antes(self):
        # Los seis grabadores que ya corren llaman sin ese argumento.
        self.assertEqual(simbolo_broker("EURUSD=X", {"EURUSD", "EURUSD#"}), "EURUSD")

    def test_el_pelado_gana_si_es_operable(self):
        todos = {"USDJPY", "USDJPY#"}
        self.assertEqual(simbolo_broker("USDJPY=X", todos, {"USDJPY", "USDJPY#"}), "USDJPY")

    def test_si_ninguno_es_operable_vale_cualquiera(self):
        # Medir no es operar: quedarse sin velas porque el broker tenga el instrumento cerrado
        # seria peor que leerlas de un simbolo que hoy no se puede tocar.
        self.assertEqual(simbolo_broker("GBPJPY=X", {"GBPJPY#"}, set()), "GBPJPY#")

    def test_un_par_que_no_esta_devuelve_none(self):
        self.assertIsNone(simbolo_broker("CADJPY=X", {"EURUSD#"}, {"EURUSD#"}))

    def test_elige_siempre_el_mismo_cuando_hay_varios(self):
        # Sin orden, dos pasadas seguidas podrian coger simbolos distintos y el registro
        # mezclaria instrumentos sin que nada avisara.
        todos = {"EURUSD#", "EURUSD.raw", "EURUSDm"}
        self.assertEqual(
            simbolo_broker("EURUSD=X", todos, todos), simbolo_broker("EURUSD=X", todos, todos),
        )

    def test_operables_de_filtra_por_trade_mode(self):
        class S:
            def __init__(self, name, trade_mode):
                self.name, self.trade_mode = name, trade_mode
        # 4 es SYMBOL_TRADE_MODE_FULL; 0 es desactivado y 3 es "solo cerrar".
        dados = [S("EURUSD", 0), S("EURUSD#", 4), S("GOLD#", 3)]
        self.assertEqual(operables_de(dados), {"EURUSD#"})


class Identidad(unittest.TestCase):
    def test_es_estable_y_quita_el_sufijo_de_yahoo(self):
        self.assertEqual(identidad("USDJPY=X", 1789171051), "USDJPY:1789171051")
        self.assertEqual(identidad("USDJPY=X", 1789171051.0), "USDJPY:1789171051")

    def test_dos_señales_del_mismo_par_en_velas_distintas_no_se_confunden(self):
        self.assertNotEqual(identidad("USDJPY=X", 1), identidad("USDJPY=X", 2))

    def test_cabe_en_el_comentario_de_una_orden_de_mt5(self):
        # MT5 corta el comentario a 31 caracteres. Si la identidad no cabe, dos señales
        # distintas podrian quedar con el mismo comentario en el broker.
        self.assertLessEqual(len(identidad("GBPJPY=X", 9_999_999_999)), 31)


if __name__ == "__main__":
    unittest.main()


class OrdenAMercado(unittest.TestCase):
    """
    Las guardas de la entrada a mercado, que es la que puede hacer daño de verdad.

    Una limitada rancia es inofensiva: se queda posada y si el precio no vuelve, no pasa nada.
    Una a mercado entra SIEMPRE, al precio que haya. Todo lo de aqui existe para que no entre
    cuando la operacion ya dejo de ser la que era.
    """

    def test_compra_al_ask_y_vende_al_bid(self):
        # Las velas son BID, asi que el precio de la señal NO es el de compra. Dimensionar con
        # el de la señal daria un riesgo real distinto del calculado.
        vale, _, entrada = mercado_valido("LARGO", 99.0, 103.0, 100.0, 100.2)
        self.assertTrue(vale)
        self.assertEqual(entrada, 100.2)
        vale, _, entrada = mercado_valido("CORTO", 101.0, 97.0, 100.0, 100.2)
        self.assertTrue(vale)
        self.assertEqual(entrada, 100.0)

    def test_no_entra_si_el_precio_ya_paso_el_stop(self):
        # Comprar con el stop por encima del precio es abrir una operacion ya perdida.
        vale, motivo, _ = mercado_valido("LARGO", 101.0, 105.0, 100.0, 100.2)
        self.assertFalse(vale)
        self.assertIn("stop", motivo)
        vale, motivo, _ = mercado_valido("CORTO", 99.0, 95.0, 100.0, 100.2)
        self.assertFalse(vale)

    def test_no_entra_si_el_precio_ya_llego_al_objetivo(self):
        vale, motivo, _ = mercado_valido("LARGO", 99.0, 100.1, 100.0, 100.2)
        self.assertFalse(vale)
        self.assertIn("objetivo", motivo)

    def test_no_entra_si_se_comio_el_recorrido(self):
        # La estrategia planeaba 2R. Si el precio ya hizo la mitad, lo que queda no es esa
        # apuesta: se arriesga lo mismo para ganar la mitad.
        #
        # stop 99, objetivo 103, señal en 100 (2R al planearla). Si ahora pide 102, quedan
        # 1 de premio contra 3 de riesgo: 0,33R.
        vale, motivo, _ = mercado_valido("LARGO", 99.0, 103.0, 101.9, 102.0, rr_minimo=1.0)
        self.assertFalse(vale)
        self.assertIn("escapo", motivo)
        # Y con el minimo bajado, la misma señal si entra: la guarda es el parametro, no un muro.
        vale, _, _ = mercado_valido("LARGO", 99.0, 103.0, 101.9, 102.0, rr_minimo=0.3)
        self.assertTrue(vale)

    def test_sin_cotizacion_no_entra(self):
        self.assertFalse(mercado_valido("LARGO", 99.0, 103.0, 0.0, 0.0)[0])

    def test_la_frescura_mira_la_vela_de_la_senal(self):
        ahora = 1_000_000
        self.assertTrue(senal_fresca(ahora - 300, ahora, 900)[0])
        vale, motivo = senal_fresca(ahora - 3600, ahora, 900)
        self.assertFalse(vale)
        self.assertIn("min", motivo)

    def test_frescura_cero_no_comprueba_nada(self):
        # Para poder apagarla sin tocar codigo, igual que el resto de topes.
        self.assertTrue(senal_fresca(0, 1_000_000, 0)[0])

    def test_una_limitada_vieja_no_es_lo_mismo_que_una_de_mercado_vieja(self):
        # La limitada solo comprueba que el nivel siga al lado correcto; no le importa la edad,
        # porque el precio que conseguira es el que pidio. Esta prueba fija esa diferencia.
        self.assertTrue(limitada_valida("LARGO", 99.0, 100.0, 100.2)[0])


class Tick:
    """Lo minimo que `tick_utilizable` mira de una cotizacion."""

    def __init__(self, bid, ask, t):
        self.bid, self.ask, self.time = bid, ask, t


class MedirAntesDeDecidir(unittest.TestCase):
    """
    Que ninguna operacion se caiga por un fallo de MEDIDA en vez de por su coste.

    Es la diferencia entre "esta operacion es cara" y "no he podido saber si lo es". La primera
    es una decision; la segunda es un fallo disfrazado de decision, y es la que hay que evitar.
    """

    # El servidor del broker va en UTC+3.
    DESFASE = 3 * 3600

    def test_el_desfase_se_deduce_del_tick(self):
        # Sin esto, TODO tick pareceria tener tres horas y nada pasaria nunca la frescura.
        ahora = 1_000_000
        self.assertEqual(desfase_reloj(ahora + 3 * 3600, ahora), 3 * 3600)
        self.assertEqual(desfase_reloj(ahora, ahora), 0)
        # Hay husos a :30, y por eso se redondea a la media hora y no a la hora.
        self.assertEqual(desfase_reloj(ahora + 5 * 3600 + 1800, ahora), 5 * 3600 + 1800)

    def test_un_tick_de_ahora_vale(self):
        ahora = 1_000_000
        vale, edad, _ = tick_utilizable(Tick(1.1, 1.1002, ahora + self.DESFASE), self.DESFASE, ahora)
        self.assertTrue(vale)
        self.assertLess(abs(edad), 1)

    def test_EL_TICK_DEL_VIERNES_NO_VALE_PARA_MEDIR(self):
        # Es el caso que importa: con el mercado cerrado MT5 sigue devolviendo el ultimo tick, y
        # ese lleva el spread de cierre, que es el peor de la semana. Filtrar por peaje contra el
        # rechazaria operaciones por un coste que no es el suyo.
        ahora = 1_000_000
        viernes = ahora - 48 * 3600
        vale, edad, motivo = tick_utilizable(Tick(1.1, 1.1050, viernes + self.DESFASE),
                                             self.DESFASE, ahora)
        self.assertFalse(vale)
        self.assertGreater(edad, 47 * 3600)
        self.assertIn("cerrado", motivo)

    def test_sin_cotizacion_tampoco_vale(self):
        ahora = 1_000_000
        self.assertFalse(tick_utilizable(None, 0, ahora)[0])
        self.assertFalse(tick_utilizable(Tick(0, 0, ahora), 0, ahora)[0])

    def test_el_margen_de_frescura_se_puede_pedir(self):
        ahora = 1_000_000
        t = Tick(1.1, 1.1002, ahora - 120 + self.DESFASE)
        self.assertTrue(tick_utilizable(t, self.DESFASE, ahora, max_edad=180)[0])
        self.assertFalse(tick_utilizable(t, self.DESFASE, ahora, max_edad=60)[0])

    def test_sin_corregir_el_desfase_ningun_tick_pasaria(self):
        # La prueba de que el desfase no es un adorno: el mismo tick fresco, leido sin corregir,
        # parece tener tres horas y se descartaria.
        ahora = 1_000_000
        t = Tick(1.1, 1.1002, ahora + self.DESFASE)
        self.assertTrue(tick_utilizable(t, self.DESFASE, ahora)[0])
        self.assertFalse(tick_utilizable(t, 0, ahora)[0])


class CaducidadDeMercado(unittest.TestCase):
    """
    Una orden a mercado no caduca por `caducaEn`, y esto tumbaba TODAS en silencio.

    `caducaEn` significa "cuanto espera la limitada a que el precio vuelva". Para una de mercado
    no hay espera, y su vigencia de 1 vela hace que `caducaEn` sea tSeñal + 300s — un instante que
    el reloj YA ha pasado cuando el grabador ve la señal, porque solo la ve tras cerrar su vela.
    """

    def pendiente(self, tipo=None, t_senal=1000, caduca=1300):
        p = {"par": "EURUSD=X", "direccion": "LARGO", "entrada": 1.1, "stop": 1.09,
             "objetivo": 1.12, "rr": 2.0, "tSeñal": t_senal, "caducaEn": caduca}
        if tipo:
            p["tipo"] = tipo
        return p

    def test_una_limitada_pasada_de_fecha_se_descarta(self):
        poner, saltar = que_hacer([self.pendiente()], set(), 1400, 12, 0)
        self.assertEqual(poner, [])
        self.assertIn("caducada", saltar[0][1])

    def test_UNA_DE_MERCADO_NO_SE_DESCARTA_POR_ESO(self):
        # El caso real: `ahora` (1400) pasa de `caducaEn` (1300) porque el grabador solo ve la
        # señal cuando su vela cerro. Si esto se descartara, no se pondria ninguna nunca.
        poner, saltar = que_hacer([self.pendiente("MERCADO")], set(), 1400, 12, 0)
        self.assertEqual(len(poner), 1)
        self.assertEqual(saltar, [])

    def test_lo_que_si_acota_la_de_mercado_es_la_frescura(self):
        # No es que no tenga limite: el limite es otro y se comprueba aparte.
        self.assertTrue(senal_fresca(1000, 1300, 900)[0])
        self.assertFalse(senal_fresca(1000, 2500, 900)[0])

    def test_una_limitada_dentro_de_plazo_se_pone(self):
        poner, _ = que_hacer([self.pendiente()], set(), 1200, 12, 0)
        self.assertEqual(len(poner), 1)


class ElRelojDelMercado(unittest.TestCase):
    """
    De donde sale el reloj con el que se mide si una cotizacion sirve.

    Importa porque el spread de esa cotizacion es el que decide el PEAJE: medirlo sobre un tick
    viejo rechaza operaciones por un coste que no es el suyo, y eso es perder una operacion por
    un fallo de medida.
    """

    AHORA = 1_789_500_000
    XM = 3 * 3600

    def test_sale_del_tick_mas_nuevo_y_no_del_mas_viejo(self):
        # Un par parado y otro cotizando: manda el que cotiza.
        parado = self.AHORA + self.XM - 40 * 3600
        vivo = self.AHORA + self.XM - 3
        d, n = reloj_del_mercado([parado, vivo], self.AHORA)
        self.assertEqual((d, n), (self.XM, 2))

    def test_sin_cotizaciones_no_se_inventa_ninguna_hora(self):
        self.assertEqual(reloj_del_mercado([], self.AHORA), (0, 0))
        self.assertEqual(reloj_del_mercado([0, None], self.AHORA), (0, 0))

    def test_DEDUCIRLO_DEL_MISMO_TICK_SE_CANCELA_SOLO(self):
        # La razon de que esta funcion exista. Con el desfase sacado del propio tick, la edad que
        # sale es el resto de (tick - ahora) entre media hora: nunca pasa de 900 s, por viejo que
        # sea. Un tick de hace DOS DIAS pasa por recien hecho.
        viejo = self.AHORA + self.XM - 48 * 3600
        circular = desfase_reloj(viejo, self.AHORA)
        edad_circular = self.AHORA - (viejo - circular)
        self.assertLessEqual(abs(edad_circular), 900)

        # Con el reloj sacado de un par que si cotiza, los dos dias se ven enteros.
        bueno, _ = reloj_del_mercado([viejo, self.AHORA + self.XM - 2], self.AHORA)
        self.assertAlmostEqual((self.AHORA - (viejo - bueno)) / 3600, 48, places=3)

    def test_y_entonces_tick_utilizable_hace_su_trabajo(self):
        class Tick:
            bid, ask = 1.1, 1.1001

        t = Tick()
        t.time = self.AHORA + self.XM - 48 * 3600
        # Con el reloj circular la da por buena; con el del mercado, no.
        self.assertTrue(tick_utilizable(t, desfase_reloj(t.time, self.AHORA), self.AHORA)[0])
        bueno, _ = reloj_del_mercado([t.time, self.AHORA + self.XM - 2], self.AHORA)
        vale, edad, motivo = tick_utilizable(t, bueno, self.AHORA)
        self.assertFalse(vale)
        self.assertIn("mercado parece cerrado", motivo)

    def test_un_retraso_de_media_hora_justa_es_el_caso_peor(self):
        # No hace falta el fin de semana: cualquier retraso cercano a un multiplo de media hora
        # se cancela igual, y en horas finas eso pasa.
        t = self.AHORA + self.XM - 1800
        self.assertEqual(self.AHORA - (t - desfase_reloj(t, self.AHORA)), 0)
        bueno, _ = reloj_del_mercado([t, self.AHORA + self.XM - 1], self.AHORA)
        self.assertEqual(self.AHORA - (t - bueno), 1800)
