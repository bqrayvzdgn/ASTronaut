namespace Contracts;

// Shared DTO returned by both API projects: it must be hoisted into
// components/schemas exactly once (R2/R6), not once per compilation.
public sealed class Customer
{
    public int Id { get; set; }
    public required string Email { get; set; }
}
