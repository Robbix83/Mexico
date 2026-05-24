#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Replace Avigilon section in dashboard.html with complete product list."""
import sys, io, re
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

DS_H5PRO    = 'https://www.avigilon.com/fs/documents/avigilon-h5-pro-camera-datasheet-en.pdf'
DS_H6X_B    = 'https://www.avigilon.com/fs/documents/avigilon-h6x-box-camera-datasheet-en.pdf'
DS_H5A      = 'https://www.avigilon.com/fs/documents/avigilon-h5a-line-camera-datasheet-en.pdf'
DS_H6A_D    = 'https://www.avigilon.com/fs/documents/avigilon-h6a-dome-camera-datasheet-en.pdf'
DS_H6A_B    = 'https://www.avigilon.com/fs/documents/avigilon-unity-h6a-h6x-bullet-camera-datasheet-en.pdf'
DS_H6SL     = 'https://www.avigilon.com/fs/documents/avigilon-h6sl-datasheet-en.pdf'
DS_H6M      = 'https://www.avigilon.com/fs/documents/avigilon-h6m-dome-datasheet-en.pdf'
DS_H6F      = 'https://www.avigilon.com/fs/documents/avigilon-h6f-fisheye-camera-datasheet-en.pdf'
DS_H6ADH    = 'https://docs.avigilon.com/bundle/avigilon-h6a-dual-head-camera-datasheet-en/resource/avigilon-h6a-dual-head-camera-datasheet-en.pdf'
DS_H6A_PTZ  = 'https://docs.avigilon.com/bundle/h6-a-ptz-camera-datasheet/resource/h6-a-ptz-camera-datasheet.pdf'
DS_H5A_MH   = 'https://www.avigilon.com/fs/documents/avigilon-h5a-mh-datasheet-en.pdf'
DS_H5A_T    = 'https://www.avigilon.com/fs/documents/avigilon-h5a-thermal-datasheet-en.pdf'
DS_H5A_IRPTZ= 'https://www.avigilon.com/fs/documents/avigilon-h5airptz-camera-datasheet-en.pdf'
DS_H5A_PTZ  = 'https://www.avigilon.com/fs/documents/avigilon-h5a-ptz-camera-datasheet-en.pdf'
DS_H5M      = 'https://www.avigilon.com/fs/documents/avigilon-h5m-dome-datasheet-en.pdf'
DS_NVR6_VAL = 'https://docs.avigilon.com/bundle/avigilon-nvr6-value-datasheet/resource/avigilon-nvr6-value-datasheet.pdf'
DS_AIA2X    = 'https://docs.avigilon.com/bundle/avigilon-ai-appliance-2x-datasheet/resource/avigilon-ai-appliance-2x-datasheet.pdf'
DS_HDVA3X   = 'https://docs.avigilon.com/bundle/avigilon-hdva3xl-datasheet/resource/avigilon-hdva3xl-datasheet.pdf'
DS_NVR6_STD = 'https://docs.avigilon.com/bundle/avigilon-nvr6-standard-datasheet/resource/avigilon-nvr6-standard-datasheet.pdf'
DS_NVR6_PRM = 'https://docs.avigilon.com/bundle/avigilon-nvr6-premium-datasheet/resource/avigilon-nvr6-premium-datasheet.pdf'
DS_AINVR2V  = 'https://docs.avigilon.com/bundle/avigilon-ai-nvr-2-value-datasheet/resource/avigilon-ai-nvr-2-value-datasheet.pdf'
DS_AINVR2S  = 'https://docs.avigilon.com/bundle/avigilon-ai-nvr-2-standard-datasheet/resource/avigilon-ai-nvr-2-standard-datasheet.pdf'
DS_AINVR2P  = 'https://docs.avigilon.com/bundle/avigilon-ai-nvr-2-premium-datasheet/resource/avigilon-ai-nvr-2-premium-datasheet.pdf'
DS_ENVR2    = 'https://www.avigilon.com/fs/documents/avigilon-envr2-datasheet-en.pdf'
DS_LENS     = 'https://www.avigilon.com/fs/documents/avigilon-h6x-box-camera-datasheet-en.pdf'
DS_VB400    = 'https://d8eqw8u9b6kgn.cloudfront.net/documents/avigilon_vb400_data-sheet.pdf'
DS_RM7      = 'https://www.avigilon.com/fs/documents/avigilon-rm7-wks-datasheet-en.pdf'
DS_NVR5     = 'https://www.avigilon.com/fs/documents/avigilon-nvr5-wks-datasheet-en.pdf'

# ── Products ──────────────────────────────────────────────────────────────────
# (cat, model, desc, price_usd, ds_url)
P = []
def r(cat, model, desc, price, ds=''):
    P.append((cat, model, desc, price, ds))

# ── Box Cameras / H5PRO ───────────────────────────────────────────────────────
r('קופסה / בולט','8C-H5PRO-B',  '4K 8MP H5 Pro Box, Next-Gen Analytics, no lens/housing', 3540.06, DS_H5PRO)
r('קופסה / בולט','16C-H5PRO-B', '5K 16MP H5 Pro Box, Next-Gen Analytics, no lens/housing',8850.16, DS_H5PRO)
r('קופסה / בולט','26C-H5PRO-B', '6.25K 26MP H5 Pro Box, Next-Gen Analytics, no lens/housing',10620.19,DS_H5PRO)
r('קופסה / בולט','40C-H5PRO-B', '8K 40MP H5 Pro Box, Next-Gen Analytics, no lens/housing',12980.24,DS_H5PRO)
r('קופסה / בולט','61C-H5PRO-B', '10K 61MP H5 Pro Box, Next-Gen Analytics, no lens/housing',17700.33,DS_H5PRO)
# H6X Box
r('קופסה / בולט','2.0C-H6X-B',  '2MP H6X Box Camera, CS/iCS Lens Compatible', 891.26,  DS_H6X_B)
r('קופסה / בולט','4.0C-H6X-B',  '4MP H6X Box Camera, CS/iCS Lens Compatible', 1155.01, DS_H6X_B)
r('קופסה / בולט','6.0C-H6X-B',  '6MP H6X Box Camera, CS/iCS Lens Compatible', 1313.26, DS_H6X_B)
r('קופסה / בולט','8.0C-H6X-B',  '8MP H6X Box Camera, CS/iCS Lens Compatible', 1550.64, DS_H6X_B)
# H5A Box
r('קופסה / בולט','2.0C-H5A-B1', '2MP H5A Box, WDR, LightCatcher, 4.7-84.6mm f/1.6, Next-Gen Analytics', 997.12, DS_H5A)
# H5A Bullet
r('קופסה / בולט','2.0C-H5A-BO2-IR','2MP H5A Bullet, WDR, LightCatcher, 9-22mm f/1.6, IR, Next-Gen Analytics', 1227.46, DS_H5A)
r('קופסה / בולט','4.0C-H5A-BO1-IR','4MP H5A Bullet, WDR, LightCatcher, 3.3-9mm f/1.3, IR, Next-Gen Analytics', 1347.77, DS_H5A)
# H6A Bullet
r('קופסה / בולט','2.0C-H6A-BO1-IR','2MP H6A Bullet IR, 2.8-12mm Lens', 1293.05, DS_H6A_B)
r('קופסה / בולט','2.0C-H6A-BO2-IR','2MP H6A Bullet IR, 33x Zoom Lens',  1588.45, DS_H6A_B)
r('קופסה / בולט','4.0C-H6A-BO1-IR','4MP H6A Bullet IR, 4.4-9.3mm Lens', 1556.80, DS_H6A_B)
r('קופסה / בולט','4.0C-H6A-BO2-IR','4MP H6A Bullet IR, 31x Zoom Lens',  1852.20, DS_H6A_B)
r('קופסה / בולט','6.0C-H6A-BO1-IR','6MP H6A Bullet IR, 4.4-9.3mm Lens', 1715.05, DS_H6A_B)
r('קופסה / בולט','6.0C-H6A-BO2-IR','6MP H6A Bullet IR, 31x Zoom Lens',  2010.45, DS_H6A_B)
r('קופסה / בולט','8.0C-H6A-BO1-IR','8MP H6A Bullet IR, 4.4-9.3mm Lens', 1952.42, DS_H6A_B)
r('קופסה / בולט','8.0C-H6A-BO2-IR','8MP H6A Bullet IR, 31x Zoom Lens',  2247.82, DS_H6A_B)
# H6X Bullet
r('קופסה / בולט','4.0C-H6X-BO1-IR','4MP H6X Bullet IR, 4.4-9.3mm Lens', 1556.80, DS_H6A_B)
r('קופסה / בולט','4.0C-H6X-BO2-IR','4MP H6X Bullet IR, 31x Zoom Lens',  2089.21, DS_H6A_B)
r('קופסה / בולט','8.0C-H6X-BO1-IR','8MP H6X Bullet IR, 4.4-9.3mm Lens', 2202.26, DS_H6A_B)
r('קופסה / בולט','8.0C-H6X-BO2-IR','8MP H6X Bullet IR, 31x Zoom Lens',  2535.46, DS_H6A_B)
# H6SL Bullet
r('קופסה / בולט','2.0C-H6SL-BO1-IR','2MP H6SL Bullet, WDR, LightCatcher, 3.4-10.5mm f/1.6, IR',  763.00, DS_H6SL)
r('קופסה / בולט','3.0C-H6SL-BO1-IR','3MP H6SL Bullet, WDR, LightCatcher, 3.4-10.5mm f/1.6, IR',  853.00, DS_H6SL)
r('קופסה / בולט','3.0C-H6SL-BO2-IR','3MP H6SL Bullet, WDR, LightCatcher, 10.9-29mm f/1.7, IR',   918.00, DS_H6SL)
r('קופסה / בולט','5.0C-H6SL-BO1-IR','5MP H6SL Bullet, WDR, LightCatcher, 3.4-10.5mm f/1.6, IR', 1015.00, DS_H6SL)
r('קופסה / בולט','5.0C-H6SL-BO2-IR','5MP H6SL Bullet, WDR, LightCatcher, 10.9-29mm f/1.7, IR',  1083.00, DS_H6SL)
r('קופסה / בולט','8.0C-H6SL-BO1-IR','8MP H6SL Bullet, WDR, LightCatcher, 4.4-9.3mm f/1.3, IR',  1261.00, DS_H6SL)

# ── Indoor Dome ───────────────────────────────────────────────────────────────
# H6A Indoor
r('כיפה פנים','2.0C-H6A-D1',    '2MP H6A Indoor Dome, 2.8-12mm Lens',         944.01, DS_H6A_D)
r('כיפה פנים','2.0C-H6A-D1-IR', '2MP H6A Indoor IR Dome, 2.8-12mm Lens',     1002.73, DS_H6A_D)
r('כיפה פנים','2.0C-H6A-D2',    '2MP H6A Indoor Dome, 10.9-29mm Lens',        991.00, DS_H6A_D)
r('כיפה פנים','2.0C-H6A-D2-IR', '2MP H6A Indoor IR Dome, 10.9-29mm Lens',   1049.72, DS_H6A_D)
r('כיפה פנים','4.0C-H6A-D1',    '4MP H6A Indoor Dome, 4.4-9.3mm Lens',      1207.76, DS_H6A_D)
r('כיפה פנים','4.0C-H6A-D1-IR', '4MP H6A Indoor IR Dome, 4.4-9.3mm Lens',   1266.48, DS_H6A_D)
r('כיפה פנים','4.0C-H6A-D2',    '4MP H6A Indoor Dome, 10.9-29mm Lens',      1254.75, DS_H6A_D)
r('כיפה פנים','4.0C-H6A-D2-IR', '4MP H6A Indoor IR Dome, 10.9-29mm Lens',   1313.47, DS_H6A_D)
r('כיפה פנים','6.0C-H6A-D1',    '6MP H6A Indoor Dome, 4.4-9.3mm Lens',      1366.01, DS_H6A_D)
r('כיפה פנים','6.0C-H6A-D1-IR', '6MP H6A Indoor IR Dome, 4.4-9.3mm Lens',   1424.73, DS_H6A_D)
r('כיפה פנים','6.0C-H6A-D2',    '6MP H6A Indoor Dome, 10.9-29mm Lens',      1413.00, DS_H6A_D)
r('כיפה פנים','6.0C-H6A-D2-IR', '6MP H6A Indoor IR Dome, 10.9-29mm Lens',   1471.72, DS_H6A_D)
r('כיפה פנים','8.0C-H6A-D1',    '8MP H6A Indoor Dome, 4.4-9.3mm Lens',      1603.39, DS_H6A_D)
r('כיפה פנים','8.0C-H6A-D1-IR', '8MP H6A Indoor IR Dome, 4.4-9.3mm Lens',   1662.11, DS_H6A_D)
r('כיפה פנים','8.0C-H6A-D2',    '8MP H6A Indoor Dome, 10.9-29mm Lens',      1650.37, DS_H6A_D)
r('כיפה פנים','8.0C-H6A-D2-IR', '8MP H6A Indoor IR Dome, 10.9-29mm Lens',   1709.10, DS_H6A_D)
# H6SL Indoor
r('כיפה פנים','2.0C-H6SL-D1',    '2MP H6SL Indoor Dome, WDR, LightCatcher, 3.4-10.5mm f/1.6',  518.00, DS_H6SL)
r('כיפה פנים','2.0C-H6SL-D1-IR', '2MP H6SL Indoor IR Dome, WDR, LightCatcher, 3.4-10.5mm f/1.6', 562.00, DS_H6SL)
r('כיפה פנים','3.0C-H6SL-D1',    '3MP H6SL Indoor Dome, WDR, LightCatcher, 3.4-10.5mm f/1.6',  603.00, DS_H6SL)
r('כיפה פנים','3.0C-H6SL-D1-IR', '3MP H6SL Indoor IR Dome, WDR, LightCatcher, 3.4-10.5mm f/1.6', 648.00, DS_H6SL)
r('כיפה פנים','5.0C-H6SL-D1',    '5MP H6SL Indoor Dome, WDR, LightCatcher, 3.4-10.5mm f/1.6',  760.00, DS_H6SL)
r('כיפה פנים','5.0C-H6SL-D1-IR', '5MP H6SL Indoor IR Dome, WDR, LightCatcher, 3.4-10.5mm f/1.6', 807.00, DS_H6SL)
# H5A In-ceiling
r('כיפה פנים','2.0C-H5A-DC2',   '2MP H5A In-Ceiling Dome, WDR, LightCatcher, 9-22mm f/1.6, Next-Gen Analytics', 1050.23, DS_H5A)

# ── Outdoor Dome ──────────────────────────────────────────────────────────────
# H6A Outdoor
r('כיפה חוץ','2.0C-H6A-DO1',    '2MP H6A Outdoor Dome, 2.8-12mm Lens',      1128.62, DS_H6A_D)
r('כיפה חוץ','2.0C-H6A-DO1-IR', '2MP H6A Outdoor IR Dome, 2.8-12mm Lens',   1187.35, DS_H6A_D)
r('כיפה חוץ','2.0C-H6A-DO2',    '2MP H6A Outdoor Dome, 10.9-29mm Lens',     1175.61, DS_H6A_D)
r('כיפה חוץ','2.0C-H6A-DO2-IR', '2MP H6A Outdoor IR Dome, 10.9-29mm Lens',  1234.34, DS_H6A_D)
r('כיפה חוץ','4.0C-H6A-DO1',    '4MP H6A Outdoor Dome, 4.4-9.3mm Lens',     1392.37, DS_H6A_D)
r('כיפה חוץ','4.0C-H6A-DO1-IR', '4MP H6A Outdoor IR Dome, 4.4-9.3mm Lens',  1451.10, DS_H6A_D)
r('כיפה חוץ','4.0C-H6A-DO2',    '4MP H6A Outdoor Dome, 10.9-29mm Lens',     1439.36, DS_H6A_D)
r('כיפה חוץ','4.0C-H6A-DO2-IR', '4MP H6A Outdoor IR Dome, 10.9-29mm Lens',  1498.09, DS_H6A_D)
r('כיפה חוץ','6.0C-H6A-DO1',    '6MP H6A Outdoor Dome, 4.4-9.3mm Lens',     1550.62, DS_H6A_D)
r('כיפה חוץ','6.0C-H6A-DO1-IR', '6MP H6A Outdoor IR Dome, 4.4-9.3mm Lens',  1609.35, DS_H6A_D)
r('כיפה חוץ','6.0C-H6A-DO2',    '6MP H6A Outdoor Dome, 10.9-29mm Lens',     1597.61, DS_H6A_D)
r('כיפה חוץ','6.0C-H6A-DO2-IR', '6MP H6A Outdoor IR Dome, 10.9-29mm Lens',  1656.34, DS_H6A_D)
r('כיפה חוץ','8.0C-H6A-DO1',    '8MP H6A Outdoor Dome, 4.4-9.3mm Lens',     1788.00, DS_H6A_D)
r('כיפה חוץ','8.0C-H6A-DO1-IR', '8MP H6A Outdoor IR Dome, 4.4-9.3mm Lens',  1846.72, DS_H6A_D)
r('כיפה חוץ','8.0C-H6A-DO2',    '8MP H6A Outdoor Dome, 10.9-29mm Lens',     1834.99, DS_H6A_D)
r('כיפה חוץ','8.0C-H6A-DO2-IR', '8MP H6A Outdoor IR Dome, 10.9-29mm Lens',  1893.71, DS_H6A_D)
# H6X Outdoor
r('כיפה חוץ','4.0C-H6X-DO1-IR', '4MP H6X Outdoor IR Dome, 4.4-9.3mm Lens',  1451.10, DS_H6A_D)
r('כיפה חוץ','4.0C-H6X-DO2-IR', '4MP H6X Outdoor IR Dome, 10.9-29mm Lens',  1498.09, DS_H6A_D)
r('כיפה חוץ','8.0C-H6X-DO1-IR', '8MP H6X Outdoor IR Dome, 4.4-9.3mm Lens',  1846.72, DS_H6A_D)
r('כיפה חוץ','8.0C-H6X-DO2-IR', '8MP H6X Outdoor IR Dome, 10.9-29mm Lens',  1893.71, DS_H6A_D)
# H6SL Outdoor
r('כיפה חוץ','2.0C-H6SL-DO1-IR','2MP H6SL Outdoor IR Dome, WDR, LightCatcher, 3.4-10.5mm f/1.6',  657.00, DS_H6SL)
r('כיפה חוץ','3.0C-H6SL-DO1-IR','3MP H6SL Outdoor IR Dome, WDR, LightCatcher, 3.4-10.5mm f/1.6',  747.00, DS_H6SL)
r('כיפה חוץ','5.0C-H6SL-DO1-IR','5MP H6SL Outdoor IR Dome, WDR, LightCatcher, 3.4-10.5mm f/1.6',  909.00, DS_H6SL)
r('כיפה חוץ','8.0C-H6SL-DO1-IR','8MP H6SL Outdoor IR Dome, WDR, LightCatcher, 4.4-9.3mm f/1.3',  1155.00, DS_H6SL)
# H5A Outdoor
r('כיפה חוץ','6.0C-H5A-DO1',    '6MP H5A Outdoor Dome, WDR, LightCatcher, 4.9-8mm f/1.8, Next-Gen Analytics', 1457.67, DS_H5A)
r('כיפה חוץ','4.0C-H5A-DO1-IR', '4MP H5A Outdoor IR Dome, WDR, LightCatcher, 3.3-9mm f/1.3, Next-Gen Analytics',1347.77, DS_H5A)

# ── Mini Dome ─────────────────────────────────────────────────────────────────
r('כיפה מיני','2.0C-H6M-D1',    '2MP H6M Indoor Mini Dome, WDR, LightCatcher, 2.9mm f/2.0',       320.54, DS_H6M)
r('כיפה מיני','2.0C-H6M-D1-IR', '2MP H6M Indoor IR Mini Dome, WDR, LightCatcher, 2.9mm f/2.0',    352.80, DS_H6M)
r('כיפה מיני','2.0C-H6M-DO1-IR','2MP H6M Outdoor IR Mini Dome, 3.0mm Lens',                       437.80, DS_H6M)
r('כיפה מיני','3.0C-H6M-D1',    '3MP H6M Indoor Mini Dome, WDR, LightCatcher, 2.9mm f/2.0',       368.03, DS_H6M)
r('כיפה מיני','3.0C-H6M-D1-IR', '3MP H6M Indoor IR Mini Dome, WDR, LightCatcher, 2.9mm f/2.0',    400.26, DS_H6M)
r('כיפה מיני','3.0C-H6M-D2-IR', '3MP H6M Indoor IR Mini Dome, WDR, LightCatcher, 2.4mm f/2.1',    412.13, DS_H6M)
r('כיפה מיני','5.0C-H6M-D1-IR', '5MP H6M Indoor IR Mini Dome, WDR, LightCatcher, 2.9mm f/2.0',    466.40, DS_H6M)
r('כיפה מיני','5.0C-H6M-D2-IR', '5MP H6M Indoor IR Mini Dome, WDR, LightCatcher, 2.4mm f/2.1',    478.27, DS_H6M)
r('כיפה מיני','5.0C-H6M-DO1-IR','5MP H6M Outdoor IR Mini Dome, 3.0mm Lens',                       678.00, DS_H6M)
r('כיפה מיני','2.0C-H5M-DO1-IR','2MP H5M Outdoor IR Mini Dome, WDR, LightCatcher, 2.8mm f/1.2',   377.60, DS_H5M)
r('כיפה מיני','5.0C-H5M-DO1-IR','5MP H5M Outdoor IR Mini Dome, WDR, LightCatcher, 2.8mm f/1.2',   472.01, DS_H5M)

# ── Corner ────────────────────────────────────────────────────────────────────
r('קורנר','3.0C-H5A-CR1-IR',    'H5A Corner CRS, 3MP WDR, 3-9mm, IR',          1416.02, DS_H5A)
r('קורנר','3.0C-H5A-CR1-IR-SS', 'H5A Corner Stainless Steel, 3MP WDR, 3-9mm, IR',1711.03,DS_H5A)
r('קורנר','3.0C-H5A-CR2-IR',    'H5A Corner, 3MP, 2.3mm Fixed Lens, White Steel',1272.00, DS_H5A)
r('קורנר','3.0C-H5A-CR2-IR-SS', 'H5A Corner, 3MP, 2.3mm Fixed Lens, Stainless Steel',1537.00,DS_H5A)
r('קורנר','5.0C-H5A-CR1-IR',    'H5A Corner CRS, 5MP WDR, 3-9mm, IR',          1888.03, DS_H5A)
r('קורנר','5.0C-H5A-CR1-IR-SS', 'H5A Corner Stainless Steel, 5MP WDR, 3-9mm, IR',2183.04,DS_H5A)
r('קורנר','5.0C-H5A-CR2-IR',    'H5A Corner, 5MP, 2.3mm Fixed Lens, White Steel',1696.00, DS_H5A)
r('קורנר','5.0C-H5A-CR2-IR-SS', 'H5A Corner, 5MP, 2.3mm Fixed Lens, Stainless Steel',1961.00,DS_H5A)

# ── PTZ ───────────────────────────────────────────────────────────────────────
r('PTZ','2.0C-H6A-PTZ-DC30','H6A PTZ In-Ceiling, 2MP, 30X',    3500.00, DS_H6A_PTZ)
r('PTZ','2.0C-H6A-PTZ-DP30','H6A PTZ Pendant, 2MP, 30X',       3500.00, DS_H6A_PTZ)
r('PTZ','4.0C-H6A-PTZ-DC30','H6A PTZ In-Ceiling, 4MP, 30X',    3700.00, DS_H6A_PTZ)
r('PTZ','4.0C-H6A-PTZ-DP30','H6A PTZ Pendant, 4MP, 30X',       3700.00, DS_H6A_PTZ)
r('PTZ','8.0C-H5A-PTZ-DC36','H5A PTZ In-Ceiling, 8MP, 36X',    4124.29, DS_H5A_PTZ)
r('PTZ','8.0C-H5A-PTZ-DP36','H5A PTZ Pendant, 8MP, 36X',       4124.29, DS_H5A_PTZ)
r('PTZ','2.0C-H5A-IRPTZ-DP40-WP','H5A IR PTZ Pendant, 2MP, 40X, 300m IR',  4198.00, DS_H5A_IRPTZ)
r('PTZ','4.0C-H5A-IRPTZ-DP36-WP','H5A IR PTZ Pendant, 4MP, 36X, 150m IR',  4709.00, DS_H5A_IRPTZ)
r('PTZ','8.0C-H5A-IRPTZ-DP36-WP','H5A IR PTZ Pendant, 8MP, 36X, 150m IR',  5299.00, DS_H5A_IRPTZ)

# ── Panoramic / Fisheye / Multisensor ─────────────────────────────────────────
# H6F Fisheye
r('פנורמי','8.0C-H6A-FE-180-DO2',    'H6F Outdoor 180, 8MP, WDR/LightCatcher',    840.00, DS_H6F)
r('פנורמי','8.0C-H6A-FE-180-DO2-IR', 'H6F Outdoor 180 IR, 8MP, WDR/LightCatcher', 900.00, DS_H6F)
r('פנורמי','8.0C-H6A-FE-360-DO1',    'H6F Outdoor 360, 8MP, WDR/LightCatcher',    840.00, DS_H6F)
r('פנורמי','8.0C-H6A-FE-360-DO1-IR', 'H6F Outdoor 360 IR, 8MP, WDR/LightCatcher', 890.00, DS_H6F)
r('פנורמי','8.0C-H6A-FE-DC1',        'H6F In-Ceiling 360, 8MP, WDR/LightCatcher',  870.00, DS_H6F)
r('פנורמי','12.0C-H6A-FE-360-DO1',   'H6F Outdoor 360, 12MP, WDR/LightCatcher',   1335.00, DS_H6F)
r('פנורמי','12.0C-H6A-FE-360-DO1-IR','H6F Outdoor 360 IR, 12MP, WDR/LightCatcher',1400.00, DS_H6F)
r('פנורמי','12.0C-H6A-FE-DC1',       'H6F In-Ceiling 360, 12MP, WDR/LightCatcher',1365.00, DS_H6F)
# H5A Fisheye
r('פנורמי','8.0C-H5A-FE-DC1','8MP H5A Fisheye In-Ceiling, LightCatcher, WDR, 1.41mm f/2.0, Next-Gen Analytics', 873.45, DS_H5A)
# H5A Multisensor 3MH (3-head)
r('פנורמי','9C-H5A-3MH',     '3x3MP H5A Multisensor, 270deg FOV, LightCatcher, 3.3-5.7mm',   2051.00, DS_H5A_MH)
r('פנורמי','9C-H5A-3MH-DP1', '3x3MP H5A Multisensor, 270deg FOV, with Pendant Adapter',      2449.56, DS_H5A_MH)
r('פנורמי','15C-H5A-3MH',    '3x5MP H5A Multisensor, 270deg FOV, LightCatcher, 3.3-5.7mm',   2304.00, DS_H5A_MH)
r('פנורמי','15C-H5A-3MH-DP1','3x5MP H5A Multisensor, 270deg FOV, with Pendant Adapter',      2702.56, DS_H5A_MH)
r('פנורמי','24C-H5A-3MH',    '3x8MP H5A Multisensor, 270deg FOV, LightCatcher, 3.3-5.7mm',   2651.00, DS_H5A_MH)
r('פנורמי','24C-H5A-3MH-DP1','3x8MP H5A Multisensor, 270deg FOV, with Pendant Adapter',      3049.56, DS_H5A_MH)
# H5A Multisensor 4MH (4-head)
r('פנורמי','12C-H5A-4MH',    '4x3MP H5A Multisensor, 360deg FOV, LightCatcher, 3.3-5.7mm',   2390.00, DS_H5A_MH)
r('פנורמי','12C-H5A-4MH-DP1','4x3MP H5A Multisensor, 360deg FOV, with Pendant Adapter',      2788.56, DS_H5A_MH)
r('פנורמי','20C-H5A-4MH',    '4x5MP H5A Multisensor, 360deg FOV, LightCatcher, 3.3-5.7mm',   2757.00, DS_H5A_MH)
r('פנורמי','20C-H5A-4MH-DP1','4x5MP H5A Multisensor, 360deg FOV, with Pendant Adapter',      3155.56, DS_H5A_MH)
r('פנורמי','32C-H5A-4MH',    '4x8MP H5A Multisensor, 360deg FOV, LightCatcher, 3.3-5.7mm',   3166.00, DS_H5A_MH)
r('פנורמי','32C-H5A-4MH-DP1','4x8MP H5A Multisensor, 360deg FOV, with Pendant Adapter',      3564.56, DS_H5A_MH)
# H6A Dual Head
r('פנורמי','6.0C-H6ADH-DO1-IR', '2x3MP H6A Dual Head Outdoor, IR',  1561.00, DS_H6ADH)
r('פנורמי','10.0C-H6ADH-DO1-IR','2x5MP H6A Dual Head Outdoor, IR',  1792.00, DS_H6ADH)
r('פנורמי','16.0C-H6ADH-DO1-IR','2x8MP H6A Dual Head Outdoor, IR',  2150.00, DS_H6ADH)

# ── Thermal ───────────────────────────────────────────────────────────────────
r('תרמי','320F-H5A-THC-BO12','320x256 H5A Thermal Bullet, 18mm f/1.0, NETD 50mK, 30Hz, Next-Gen Analytics',  5546.00, DS_H5A_T)
r('תרמי','320F-H5A-THC-BO16','320x256 H5A Thermal Bullet, 13.8mm f/1.0, NETD 50mK, 30Hz, Next-Gen Analytics',4995.00, DS_H5A_T)
r('תרמי','320F-H5A-THC-BO24','320x256 H5A Thermal Bullet, 9.1mm f/1.0, NETD 50mK, 30Hz, Next-Gen Analytics', 4602.00, DS_H5A_T)
r('תרמי','320F-H5A-THC-BO50','320x256 H5A Thermal Bullet, 4.3mm f/1.0, NETD 50mK, 30Hz, Next-Gen Analytics', 4366.00, DS_H5A_T)
r('תרמי','640F-H5A-THC-BO12','640x512 H5A Thermal Bullet, 36mm f/1.0, NETD 50mK, 30Hz, Next-Gen Analytics',  9853.00, DS_H5A_T)
r('תרמי','640F-H5A-THC-BO18','640x512 H5A Thermal Bullet, 24.3mm f/1.0, NETD 50mK, 30Hz, Next-Gen Analytics',8292.00, DS_H5A_T)
r('תרמי','640F-H5A-THC-BO24','640x512 H5A Thermal Bullet, 18mm f/1.0, NETD 50mK, 30Hz, Next-Gen Analytics',  7198.00, DS_H5A_T)
r('תרמי','640F-H5A-THR-BO32','640x512 H5A Radiometric Bullet, 14mm f/1.0, NETD 50mK, 30Hz, Next-Gen Analytics',7050.00,DS_H5A_T)
r('תרמי','640F-H5A-THR-BO50','640x512 H5A Radiometric Bullet, 9.2mm f/1.1, NETD 50mK, 30Hz, Next-Gen Analytics',6962.00,DS_H5A_T)

# ── Body-Worn Cameras ─────────────────────────────────────────────────────────
r('מצלמת גוף','VB-440-64-QR-N','VB400 Body-Worn Camera 64GB, Quick Release Mount, 2MP 120deg FOV, IP67, GPS, Wi-Fi, MIL-STD-810G, NA', 640.00, DS_VB400)
r('מצלמת גוף','VB-440-64-VF-N','VB400 Body-Worn Camera 64GB, Close-Fit MOLLE Mount, 2MP 120deg FOV, IP67, GPS, Wi-Fi, MIL-STD-810G, NA', 640.00, DS_VB400)
r('מצלמת גוף','VB-440-64-KF-N','VB400 Body-Worn Camera 64GB, Klick Fast Stud Mount, 2MP 120deg FOV, IP67, GPS, Wi-Fi, MIL-STD-810G, NA', 640.00, DS_VB400)
r('מצלמת גוף','VT-100-N','VT100 Body-Worn Camera 16GB, 720p HD, 130deg FOV, IP54, Wi-Fi 802.11b/g/n, Lightweight Commercial BWC, NA', 370.00, '')

# ── Lenses ────────────────────────────────────────────────────────────────────
r('עדשה','AG3Z2812KCS-MPWIR-MSI', 'CS Lens, 2.8-8.5mm f1.2, 1/2.8, 6MP',              230.00, DS_LENS)
r('עדשה','AG3Z2812TCS-MPWIR-MSI', 'iCS Lens, 2.8-8.5mm f1.2, 1/2.8, 6MP',             303.00, DS_LENS)
r('עדשה','EG3Z3915KCS-MPWIR-MSI', 'CS Lens, 3.9-10mm f1.5, 1/1.8, 4K',                260.00, DS_LENS)
r('עדשה','EG3Z3915TCS-MPWIR-MSI', 'iCS Lens, 3.9-10mm f1.5, 1/1.8, 4K',               380.00, DS_LENS)
r('עדשה','EG6Z0915TCS-MPWIR-MSI', 'iCS Lens, 9-50mm f1.5, 1/1.8, 4K',                 570.00, DS_LENS)
r('עדשה','FG50020P.IR-MSI',        'CS Lens, 3.4-9.85mm f1.86, 1/2.7, 5MP',            120.00, DS_LENS)
r('עדשה','HV03610P.IR-MSI',        'CS Lens, 4.3-9.6mm f1.8, 1/1.8, 4K',               170.00, DS_LENS)
r('עדשה','M117VG3817IR-MSI',       'CS Lens, 3.8-17mm f1.4, 1/1.7, 4K',                320.00, DS_LENS)
r('עדשה','M13VG2713IR-MSI',        'CS Lens, 2.7-13mm f1.4, 1/2.7, 3MP',               150.00, DS_LENS)
r('עדשה','SL1250P-MSI',            'CS Lens, 12-50mm f1.8, 1/1.7, 4K',                  340.00, DS_LENS)
r('עדשה','SL183A-MSI',             'CS Lens, 1.8-3mm f1.8, 1/2.7, 5MP',                363.00, DS_LENS)
r('עדשה','SL940P-MSI',             'CS Lens, 9-40mm f1.5, 1/2.7, 5MP',                  363.00, DS_LENS)
r('עדשה','LEF5018CA2',             'Canon 50mm f/1.8 Lens, compatible with H4 Pro cameras',370.21,DS_LENS)
r('עדשה','LEF7020028CA3',          'Canon 70-200mm f/2.8 III Lens',                     3795.00, DS_LENS)
r('עדשה','LEF7030040CA',           'Canon 70-300mm f/4-f/5.6 Lens, compatible with H4 Pro', 1307.73, DS_LENS)
r('עדשה','LEFS183518SI',           'Sigma 18-35mm f/1.8 Lens, compatible with 8-16MP H4 Pro / 8-26MP H5 Pro', 1778.93, DS_LENS)

# ── NVR — Value Entry Level ────────────────────────────────────────────────────
r('NVR','NVR6-VAL-FORM-D-6TB-C13-C14', 'NVR6 Value Form D, 6TB (8TB Raw), Win11 IoT Enterprise, 3Y NBD Warranty', 7373.00,  DS_NVR6_VAL)
r('NVR','NVR6-VAL-FORM-D-12TB-C13-C14','NVR6 Value Form D, 12TB (16TB Raw), Win11 IoT Enterprise, 3Y NBD Warranty',8782.00, DS_NVR6_VAL)
r('NVR','NVR6-VAL-FORM-D-16TB-C13-C14','NVR6 Value Form D, 16TB (24TB Raw), Win11 IoT Enterprise, 3Y NBD Warranty',10400.00,DS_NVR6_VAL)
r('NVR','NVR6-VAL-FORM-D-24TB-C13-C14','NVR6 Value Form D, 24TB (32TB Raw), Win11 IoT Enterprise, 3Y NBD Warranty',13583.00,DS_NVR6_VAL)

r('NVR','AINVR2X-VAL-FORM-D-6TB-C13-C14', 'AI NVR 2X Value, 6TB, 1U Rack, HardenedOS, Unity Video 8, 3Y NBD',  7493.00, DS_AINVR2V)
r('NVR','AINVR2X-VAL-FORM-D-12TB-C13-C14','AI NVR 2X Value, 12TB, 1U Rack, HardenedOS, Unity Video 8, 3Y NBD', 8397.00, DS_AINVR2V)
r('NVR','AINVR2X-VAL-FORM-D-16TB-C13-C14','AI NVR 2X Value, 16TB, 1U Rack, HardenedOS, Unity Video 8, 3Y NBD', 9665.00, DS_AINVR2V)
r('NVR','AINVR2X-VAL-FORM-D-24TB-C13-C14','AI NVR 2X Value, 24TB, 1U Rack, HardenedOS, Unity Video 8, 3Y NBD',13649.00, DS_AINVR2V)

# AI Appliance 2X
r('NVR','AIA2X-FORM-D-CG2-HW-C19-C20','AI Appliance 2X CG2, HardenedOS, Unity Video 8, includes 2x C19/C20 cords',19000.00, DS_AIA2X)
r('NVR','AIA2X-FORM-D-CG3-HW-C19-C20','AI Appliance 2X CG3, HardenedOS, Unity Video 8, includes 2x C19/C20 cords',27500.00, DS_AIA2X)

# NVR6 Standard
r('NVR','NVR6-STD-FORM-D-16TB-S22-NA','NVR6 Standard Form D, 16TB, 2U Rack, WS22, 5Y Onsite NBD', 18600.00, DS_NVR6_STD)
r('NVR','NVR6-STD-FORM-D-24TB-S22-NA','NVR6 Standard Form D, 24TB, 2U Rack, WS22, 5Y Onsite NBD', 19749.00, DS_NVR6_STD)
r('NVR','NVR6-STD-FORM-D-32TB-S22-NA','NVR6 Standard Form D, 32TB, 2U Rack, WS22, 5Y Onsite NBD', 21698.00, DS_NVR6_STD)
r('NVR','NVR6-STD-FORM-D-48TB-S22-NA','NVR6 Standard Form D, 48TB, 2U Rack, WS22, 5Y Onsite NBD', 28877.00, DS_NVR6_STD)
r('NVR','NVR6-STD-FORM-D-64TB-S22-NA','NVR6 Standard Form D, 64TB, 2U Rack, WS22, 5Y Onsite NBD', 35863.00, DS_NVR6_STD)

# NVR6 Premium
r('NVR','NVR6-PRM-FORM-D-72TB-S22-NA', 'NVR6 Premium Form D, 72TB, 2U Rack, WS22, 5Y Onsite 4HMC',  41500.00, DS_NVR6_PRM)
r('NVR','NVR6-PRM-FORM-D-96TB-S22-NA', 'NVR6 Premium Form D, 96TB, 2U Rack, WS22, 5Y Onsite 4HMC',  46700.00, DS_NVR6_PRM)
r('NVR','NVR6-PRM-FORM-D-120TB-S22-NA','NVR6 Premium Form D, 120TB, 2U Rack, WS22, 5Y Onsite 4HMC', 54953.00, DS_NVR6_PRM)
r('NVR','NVR6-PRM-FORM-D-160TB-S22-NA','NVR6 Premium Form D, 160TB, 2U Rack, WS22, 5Y Onsite 4HMC', 67485.00, DS_NVR6_PRM)
r('NVR','NVR6-PRM-FORM-D-200TB-S22-NA','NVR6 Premium Form D, 200TB, 2U Rack, WS22, 5Y Onsite 4HMC', 82717.00, DS_NVR6_PRM)

# NVR6 Premium Plus
r('NVR','NVR6-PRM-PLUS-FORM-H-200TB-S22-NA','NVR6 Premium Plus Form H, 200TB, 2U, WS22, 5Y Onsite 4HMC',  91703.00, DS_NVR6_PRM)
r('NVR','NVR6-PRM-PLUS-FORM-H-240TB-S22-NA','NVR6 Premium Plus Form H, 240TB, 2U, WS22, 5Y Onsite 4HMC', 104803.00, DS_NVR6_PRM)
r('NVR','NVR6-PRM-PLUS-FORM-H-280TB-S22-NA','NVR6 Premium Plus Form H, 280TB, 2U, WS22, 5Y Onsite 4HMC', 116367.00, DS_NVR6_PRM)
r('NVR','NVR6-PRM-PLUS-FORM-H-360TB-S22-NA','NVR6 Premium Plus Form H, 360TB, 2U, WS22, 5Y Onsite 4HMC', 138676.00, DS_NVR6_PRM)
r('NVR','NVR6-PRM-PLUS-FORM-H-440TB-S22-NA','NVR6 Premium Plus Form H, 440TB, 2U, WS22, 5Y Onsite 4HMC', 161965.00, DS_NVR6_PRM)

# AI NVR 2 Standard
r('NVR','AINVR2-STD-FORM-D-16TB-NA','AI NVR 2 Standard Form D, 16TB, 2U Rack, HardenedOS, 5Y Onsite NBD', 17600.00, DS_AINVR2S)
r('NVR','AINVR2-STD-FORM-D-24TB-NA','AI NVR 2 Standard Form D, 24TB, 2U Rack, HardenedOS, 5Y Onsite NBD', 18749.00, DS_AINVR2S)
r('NVR','AINVR2-STD-FORM-D-32TB-NA','AI NVR 2 Standard Form D, 32TB, 2U Rack, HardenedOS, 5Y Onsite NBD', 20698.00, DS_AINVR2S)
r('NVR','AINVR2-STD-FORM-D-48TB-NA','AI NVR 2 Standard Form D, 48TB, 2U Rack, HardenedOS, 5Y Onsite NBD', 27877.00, DS_AINVR2S)
r('NVR','AINVR2-STD-FORM-D-64TB-NA','AI NVR 2 Standard Form D, 64TB, 2U Rack, HardenedOS, 5Y Onsite NBD', 34863.00, DS_AINVR2S)

# AI NVR 2 Premium
r('NVR','AINVR2-PRM-FORM-D-72TB-NA', 'AI NVR 2 Premium Form D, 72TB, 2U Rack, HardenedOS, 5Y Onsite 4HMC',  41500.00, DS_AINVR2P)
r('NVR','AINVR2-PRM-FORM-D-96TB-NA', 'AI NVR 2 Premium Form D, 96TB, 2U Rack, HardenedOS, 5Y Onsite 4HMC',  46700.00, DS_AINVR2P)
r('NVR','AINVR2-PRM-FORM-D-120TB-NA','AI NVR 2 Premium Form D, 120TB, 2U Rack, HardenedOS, 5Y Onsite 4HMC', 54953.00, DS_AINVR2P)
r('NVR','AINVR2-PRM-FORM-D-160TB-NA','AI NVR 2 Premium Form D, 160TB, 2U Rack, HardenedOS, 5Y Onsite 4HMC', 67485.00, DS_AINVR2P)
r('NVR','AINVR2-PRM-FORM-D-200TB-NA','AI NVR 2 Premium Form D, 200TB, 2U Rack, HardenedOS, 5Y Onsite 4HMC', 82717.00, DS_AINVR2P)

# AI NVR 2 Premium Plus
r('NVR','AINVR2-PRM-PLUS-FORM-H-200TB-NA','AI NVR 2 Premium Plus Form H, 200TB, 2U, HardenedOS, 5Y Onsite 4HMC',  91703.00, DS_AINVR2P)
r('NVR','AINVR2-PRM-PLUS-FORM-H-240TB-NA','AI NVR 2 Premium Plus Form H, 240TB, 2U, HardenedOS, 5Y Onsite 4HMC', 104803.00, DS_AINVR2P)
r('NVR','AINVR2-PRM-PLUS-FORM-H-280TB-NA','AI NVR 2 Premium Plus Form H, 280TB, 2U, HardenedOS, 5Y Onsite 4HMC', 116367.00, DS_AINVR2P)
r('NVR','AINVR2-PRM-PLUS-FORM-H-360TB-NA','AI NVR 2 Premium Plus Form H, 360TB, 2U, HardenedOS, 5Y Onsite 4HMC', 138676.00, DS_AINVR2P)
r('NVR','AINVR2-PRM-PLUS-FORM-H-440TB-NA','AI NVR 2 Premium Plus Form H, 440TB, 2U, HardenedOS, 5Y Onsite 4HMC', 161965.00, DS_AINVR2P)

# HDVA3X (16-port)
r('NVR','VMA-AS3X-16P06-NA','HD Video Appliance 3X Pro, 16-Port 6TB, Win10 IoT Enterprise',   4921.39, DS_HDVA3X)
r('NVR','VMA-AS3X-16P12-NA','HD Video Appliance 3X Pro, 16-Port 12TB, Win10 IoT Enterprise',  7080.13, DS_HDVA3X)

# HDVA3XL (24-port)
r('NVR','VMA-AS3XL-24P06-NA','HD Video Appliance 3XL Pro, 24-Port 6TB, Win10 IoT Enterprise',   4921.00, DS_HDVA3X)
r('NVR','VMA-AS3XL-24P12-NA','HD Video Appliance 3XL Pro, 24-Port 12TB, Win10 IoT Enterprise',  6762.00, DS_HDVA3X)
r('NVR','VMA-AS3XL-24P18-NA','HD Video Appliance 3XL Pro, 24-Port 18TB, Win10 IoT Enterprise',  9246.00, DS_HDVA3X)
r('NVR','VMA-AS3XL-24P24-NA','HD Video Appliance 3XL Pro, 24-Port 24TB, Win10 IoT Enterprise', 11412.00, DS_HDVA3X)
r('NVR','VMA-AS3XL-24P48-NA','HD Video Appliance 3XL Pro, 24-Port 48TB, Win10 IoT Enterprise', 17047.00, DS_HDVA3X)

# HDVA3XL (8-port)
r('NVR','VMA-AS3XL-8P2-NA', 'HD Video Appliance 3XL, 8-Port 2TB, Win11 IoT Enterprise',   2475.00, DS_HDVA3X)
r('NVR','VMA-AS3XL-8P4-NA', 'HD Video Appliance 3XL, 8-Port 4TB, Win11 IoT Enterprise',   2686.00, DS_HDVA3X)
r('NVR','VMA-AS3XL-8P8-NA', 'HD Video Appliance 3XL, 8-Port 8TB, Win11 IoT Enterprise',   3151.00, DS_HDVA3X)
r('NVR','VMA-AS3XL-8P16-NA','HD Video Appliance 3XL, 8-Port 16TB, Win11 IoT Enterprise',  3999.00, DS_HDVA3X)

# ENVR2 Plus
r('NVR','ENVR2-PLUS-8P4-NA','ENVR2 Plus 4TB, 8-Port, with Avigilon Control Center, NA',   2110.00, DS_ENVR2)
r('NVR','ENVR2-PLUS-8P8-NA','ENVR2 Plus 8TB, 8-Port, with Avigilon Control Center, NA',   2778.00, DS_ENVR2)

# Workstations
r('NVR','RM7-WKS-2MN-NA','Remote Monitoring Workstation RM7, 2 Monitors, NA', 2350.00, DS_RM7)
r('NVR','RM7-WKS-4MN-NA','Remote Monitoring Workstation RM7, 4 Monitors, NA', 3800.00, DS_RM7)
r('NVR','NVR5-WKS-4TB-NA','NVR5 Workstation, 4TB, Windows 10, NA', 2750.00, DS_NVR5)
r('NVR','NVR5-WKS-8TB-NA','NVR5 Workstation, 8TB, Windows 10, NA', 3190.00, DS_NVR5)

# Monitors
r('מסך','M4K32-G3-NA', 'Monitor, 32" 4K UHD, 16:9 Aspect Ratio',  1500.00, '')
r('מסך','M4K43-G2-NA', 'Monitor, 43" LCD 4K UHD, 16:9 Widescreen', 1694.00,'')
r('מסך','MHD19-G3-NA', 'Monitor, 19" HD, SXGA',                      550.00, '')
r('מסך','MHD24-G3-NA', 'Monitor, 24" HD, 16:9 Aspect Ratio',         689.00, '')

# ── Generate JS ───────────────────────────────────────────────────────────────
def esc(s):
    return s.replace("'", "\\'")

lines = []
lines.append("  // ── Avigilon Unity Video (USD) ─────────────────────────────")
for cat, model, desc, price, ds in P:
    ds_str = f"'{ds}'" if ds else "''"
    price_str = str(int(price)) if price == int(price) else str(price)
    lines.append(f"  {{mfr:'Avigilon',cat:'{cat}',model:'{model}',desc:'{esc(desc)}',price:{price_str},cur:'USD',ds:{ds_str}}},")

# Remove trailing comma from last entry
lines[-1] = lines[-1].rstrip(',')

new_section = '\n'.join(lines) + '\n'
print(f"Generated {len(P)} entries")

# ── Patch dashboard.html ───────────────────────────────────────────────────────
with open('C:/Mexico/dashboard.html', 'r', encoding='utf-8') as f:
    content = f.read()

avi_start = content.find('  // ── Avigilon')
arr_end   = content.find('];', content.find('const PRICE_LIST_DATA'))

before = content[:avi_start]
after  = content[arr_end:]

new_content = before + new_section + after

with open('C:/Mexico/dashboard.html', 'w', encoding='utf-8') as f:
    f.write(new_content)

print(f"File written: {len(new_content)} chars")
print(f"Verification: entries = {new_content.count(chr(39)+'Avigilon'+chr(39))}")
