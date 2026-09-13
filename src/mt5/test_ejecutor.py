"""
Las invariantes del ejecutor, probadas sin terminal y sin mercado abierto.

    python -m unittest discover -s src/mt5 -p "test_*.py"

Lo que se prueba aqui NO es que MT5 acepte la orden —eso solo se sabe mandandola— sino las
decisiones que se toman ANTES de mandarla, que son las que pueden arruinar una cuenta en
silencio: cuantos lotes, cuanta exposicion, y si una señal ya puesta se vuelve a poner.
"""
import unittest

from ejecutor import (
    divisas, exposicion_divisas, identidad, lote, nocional, peaje,
    perdida_del_dia, que_hacer, riesgo_hueco, simbolo_broker,
)

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
    def test_nombre_exacto(self):
        self.assertEqual(simbolo_broker("USDJPY=X", {"USDJPY", "EURUSD"}), "USDJPY")

    def test_brokers_que_ponen_sufijo(self):
        self.assertEqual(simbolo_broker("USDJPY=X", {"USDJPYm", "EURUSDm"}), "USDJPYm")

    def test_si_el_broker_no_lo_tiene_devuelve_None(self):
        # Mejor None que adivinar: operar otro par por parecerse el nombre es peor que no operar.
        self.assertIsNone(simbolo_broker("CADJPY=X", {"USDJPY", "EURUSD"}))


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
