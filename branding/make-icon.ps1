Add-Type -AssemblyName System.Drawing

$bitmap = [System.Drawing.Bitmap]::new(256, 256)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)

$background = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 20, 35, 58))
$graphics.FillEllipse($background, 8, 8, 240, 240)
$stroke = [System.Drawing.Pen]::new([System.Drawing.Color]::White, 23)
$stroke.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$stroke.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$stroke.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$points = [System.Drawing.Point[]]@(
  [System.Drawing.Point]::new(56, 185),
  [System.Drawing.Point]::new(56, 75),
  [System.Drawing.Point]::new(128, 143),
  [System.Drawing.Point]::new(200, 75),
  [System.Drawing.Point]::new(200, 185)
)
$graphics.DrawLines($stroke, $points)
$accent = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 255, 139, 92))
$graphics.FillEllipse($accent, 181, 39, 33, 33)

$png = [System.IO.MemoryStream]::new()
$bitmap.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
$bytes = $png.ToArray()
$path = Join-Path $PSScriptRoot 'moderado-desktop.ico'
$file = [System.IO.File]::Create($path)
$writer = [System.IO.BinaryWriter]::new($file)
$writer.Write([uint16]0)
$writer.Write([uint16]1)
$writer.Write([uint16]1)
$writer.Write([byte]0)
$writer.Write([byte]0)
$writer.Write([byte]0)
$writer.Write([byte]0)
$writer.Write([uint16]1)
$writer.Write([uint16]32)
$writer.Write([uint32]$bytes.Length)
$writer.Write([uint32]22)
$writer.Write($bytes)
$writer.Dispose()
$generated = Join-Path $PSScriptRoot 'generated'
[System.IO.Directory]::CreateDirectory($generated) | Out-Null
foreach ($size in @(70, 150)) {
  $tile = [System.Drawing.Bitmap]::new($size, $size)
  $tileGraphics = [System.Drawing.Graphics]::FromImage($tile)
  $tileGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $tileGraphics.DrawImage($bitmap, 0, 0, $size, $size)
  $tile.Save((Join-Path $generated "code_${size}x${size}.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $tileGraphics.Dispose()
  $tile.Dispose()
}
foreach ($kind in @('big', 'small')) {
  foreach ($scale in @(100, 125, 150, 175, 200, 225, 250)) {
    $dimensions = if ($kind -eq 'big') {
      switch ($scale) {
        100 { @(164, 314) } 125 { @(192, 386) } 150 { @(246, 459) }
        175 { @(273, 556) } 200 { @(328, 604) } 225 { @(355, 700) }
        250 { @(410, 797) }
      }
    } else {
      switch ($scale) {
        100 { @(55, 55) } 125 { @(64, 68) } 150 { @(83, 80) }
        175 { @(92, 97) } 200 { @(110, 106) } 225 { @(119, 123) }
        250 { @(138, 140) }
      }
    }
    $art = [System.Drawing.Bitmap]::new($dimensions[0], $dimensions[1])
    $artGraphics = [System.Drawing.Graphics]::FromImage($art)
    $artGraphics.Clear([System.Drawing.Color]::White)
    $artGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $side = [int][Math]::Min($dimensions[0] * 0.72, $dimensions[1] * 0.72)
    $x = [int](($dimensions[0] - $side) / 2)
    $y = [int](($dimensions[1] - $side) / 2)
    $artGraphics.DrawImage($bitmap, $x, $y, $side, $side)
    $art.Save((Join-Path $generated "inno-$kind-$scale.bmp"), [System.Drawing.Imaging.ImageFormat]::Bmp)
    $artGraphics.Dispose()
    $art.Dispose()
  }
}
$png.Dispose()
$accent.Dispose()
$stroke.Dispose()
$background.Dispose()
$graphics.Dispose()
$bitmap.Dispose()
