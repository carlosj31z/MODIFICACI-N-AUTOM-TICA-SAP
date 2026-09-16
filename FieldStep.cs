namespace SapFioriAutomation
{
    /// <summary>Un paso de la secuencia/"macro": qué vista abrir y qué campo llenar en ella.</summary>
    public class FieldStep
    {
        public string Vista { get; set; } = string.Empty;
        public string CampoTecnico { get; set; } = string.Empty;

        public override string ToString() => $"{Vista} → {CampoTecnico}";
    }
}
